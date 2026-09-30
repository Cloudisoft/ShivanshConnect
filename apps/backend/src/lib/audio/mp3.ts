import { spawn } from 'node:child_process';

/** High-quality MP3 settings for call recordings: 192 kbps CBR, 44.1 kHz,
 * mono (the call itself is mono). The source is phone-call audio, so this
 * keeps everything the recording actually contains with no audible
 * compression loss, and plays in every browser and media player. */
export const MP3_ENCODE_ARGS = ['-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'];

/** Re-encodes any audio buffer ffmpeg can read (WAV, etc.) to MP3 via a
 * real `ffmpeg` child process. Rejects when ffmpeg is missing or fails;
 * callers decide the fallback. */
export function encodeMp3(sourceBuffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Reads the source from stdin rather than a file path - the bytes come
    // from memory/the storage adapter, not necessarily a local file.
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', ...MP3_ENCODE_ARGS, 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.stdin.on('error', () => {
      // EPIPE on a dead ffmpeg process - the 'error'/'close' handlers above
      // already reject; this only prevents an unhandled 'error' event.
    });
    proc.stdin.end(sourceBuffer);
  });
}

/** Loudness normalization for playback, per report ("recordings play at a
 * low sound level"): phone audio is recorded quietly (often around -30
 * LUFS). EBU R128 loudnorm brings every recording to -16 LUFS, the level
 * of podcasts and voice apps, with a -1.5 dBTP ceiling so nothing clips. */
export const LOUDNESS_ARGS = ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'];

export function normalizeLoudnessMp3(sourceBuffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', ...LOUDNESS_ARGS, ...MP3_ENCODE_ARGS, 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.stdin.on('error', () => {
      // EPIPE on a dead ffmpeg process - handled by 'error'/'close' above.
    });
    proc.stdin.end(sourceBuffer);
  });
}
