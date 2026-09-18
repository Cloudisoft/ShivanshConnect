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

    const body = await readFile(resolved);
    const type = CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': extname(resolved) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
    // eslint-disable-next-line no-console
    console.error('serve-static error:', err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Static frontend server listening on http://0.0.0.0:${PORT} (serving ${DIST_DIR})`);
});
