/**
 * Minimal, dependency-free static file server for the built frontend
 * (apps/frontend/dist), used in production instead of `vite preview`
 * (which Vite's own docs say is not meant for production use, and whose
 * startup/logging behavior proved unreliable in this Railway deployment -
 * three targeted fixes to it all failed identically with a silently
 * unreachable container and zero diagnostic output).
 *
 * Direct `node` invocation, no pnpm/vite/shell-expansion involved -
 * matches the backend's proven-working CMD pattern exactly. Reads PORT
 * from the environment with a hardcoded fallback so there is no
 * dependency on shell variable expansion at all.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

const PORT = Number(process.env.PORT) || 8080;
const DIST_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Text assets are served compressed (brotli, else gzip): the app's
 * JavaScript is ~900 KB raw but ~250 KB compressed, which is most of the
 * load time on a slow or distant connection. Each file is compressed once
 * and kept in memory - the build output never changes while this runs. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);
const compressedCache = new Map();

async function loadAsset(path) {
  const cached = compressedCache.get(path);
  if (cached) return cached;
  const raw = await readFile(path);
  const entry = { raw, br: null, gzip: null };
  if (COMPRESSIBLE.has(extname(path)) && raw.length > 1024) {
    entry.br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    entry.gzip = gzipSync(raw, { level: 9 });
  }
  compressedCache.set(path, entry);
  return entry;
}

function pickEncoding(acceptEncoding, entry) {
  const accepted = String(acceptEncoding ?? '').toLowerCase();
  if (entry.br && /\bbr\b/.test(accepted)) return 'br';
  if (entry.gzip && /\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

async function resolveFile(urlPath) {
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(DIST_DIR, safePath);
  if (!candidate.startsWith(DIST_DIR)) return null;
  try {
    const st = await stat(candidate);
    if (st.isFile()) return candidate;
  } catch {
    // fall through - not a real file, likely a client-side route
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

    let resolved = await resolveFile(filePath);
    if (!resolved) {
      // SPA fallback: any unmatched route (e.g. /campaigns/123) serves
      // index.html so client-side routing (react-router) can handle it.
      resolved = await resolveFile('/index.html');
    }
    if (!resolved) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const entry = await loadAsset(resolved);
    const encoding = pickEncoding(req.headers['accept-encoding'], entry);
    const body = encoding ? entry[encoding] : entry.raw;
    const type = CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': extname(resolved) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      Vary: 'Accept-Encoding',
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
    // eslint-disable-next-line no-console
    console.error('serve-static error:', err);
  }
});

// Compress every built asset up front so even the first request after a
// deploy gets a compressed response without waiting on compression.
async function warmCompressionCache() {
  const { readdir } = await import('node:fs/promises');
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else await loadAsset(full).catch(() => {});
    }
  };
  await walk(DIST_DIR);
}

server.listen(PORT, '0.0.0.0', () => {
  void warmCompressionCache();
  // eslint-disable-next-line no-console
  console.log(`Static frontend server listening on http://0.0.0.0:${PORT} (serving ${DIST_DIR})`);
});
