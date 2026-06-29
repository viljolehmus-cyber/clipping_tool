// ffmpeg-helper.js — thin wrapper around FFmpeg.wasm (@ffmpeg/ffmpeg 0.12.x).
// Handles lazy loading from CDN, progress events, and the per-clip pipeline:
// extract audio -> cut -> reframe -> burn captions -> thumbnail.
//
// The FFmpeg.wasm library is loaded with a *dynamic* import() inside
// loadFFmpeg() rather than a top-level static import. This keeps the app shell
// (upload, settings) fully working even if the unpkg CDN is slow or blocked —
// a CDN failure only surfaces as a clear error when the user starts processing.

const FFMPEG_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const UTIL_URL = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';

let ffmpeg = null;
let loaded = false;
let progressCb = null;
let fetchFile, toBlobURL; // bound on first load() from @ffmpeg/util

/** Subscribe to ffmpeg's internal 0..1 progress for the current exec(). */
export function onExecProgress(cb) { progressCb = cb; }

/** Load FFmpeg.wasm once. Returns the instance. */
export async function loadFFmpeg(onLog) {
  if (loaded) return ffmpeg;

  let FFmpeg;
  try {
    ({ FFmpeg } = await import(/* @vite-ignore */ FFMPEG_URL));
    ({ fetchFile, toBlobURL } = await import(/* @vite-ignore */ UTIL_URL));
  } catch (e) {
    throw new Error('Could not load FFmpeg.wasm from the CDN. Check your connection and try again.');
  }

  ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
  ffmpeg.on('progress', ({ progress }) => {
    if (progressCb && isFinite(progress)) progressCb(Math.max(0, Math.min(1, progress)));
  });

  // core-mt needs SharedArrayBuffer (provided by coi-serviceworker). Fall back
  // to the single-thread core if cross-origin isolation is unavailable.
  const mt = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
  const base = mt ? CORE_BASE : 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

  const config = {
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  };
  if (mt) config.workerURL = await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript');

  await ffmpeg.load(config);
  loaded = true;
  return ffmpeg;
}

export function isLoaded() { return loaded; }

/** Write the source video into the FFmpeg virtual FS once, reuse for all clips. */
export async function writeInput(file, name = 'input') {
  const ext = (file.name?.split('.').pop() || 'mp4').toLowerCase();
  const fsName = `${name}.${ext}`;
  await ffmpeg.writeFile(fsName, await fetchFile(file));
  return fsName;
}

/**
 * Extract compressed mono 16kHz mp3 audio (≤64kbps) to stay under Groq's 25MB.
 * Returns a Blob.
 */
export async function extractAudio(inputName) {
  await run([
    '-i', inputName,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', '64k',
    '-ac', '1',
    '-ar', '16000',
    'audio.mp3',
  ]);
  const data = await ffmpeg.readFile('audio.mp3');
  await safeDelete('audio.mp3');
  return new Blob([data.buffer], { type: 'audio/mpeg' });
}

/**
 * Extract a time-bounded audio chunk (used when full audio > 25MB).
 * Returns a Blob for [start, start+duration).
 */
export async function extractAudioChunk(inputName, start, duration, idx) {
  const out = `chunk_${idx}.mp3`;
  await run([
    '-ss', String(start),
    '-t', String(duration),
    '-i', inputName,
    '-vn', '-acodec', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '16000',
    out,
  ]);
  const data = await ffmpeg.readFile(out);
  await safeDelete(out);
  return new Blob([data.buffer], { type: 'audio/mpeg' });
}

/**
 * Full per-clip pipeline. Returns { videoBlob, thumbBlob } and cleans up
 * intermediate files. `assText` may be null to skip caption burn-in.
 */
export async function makeClip(inputName, clip, { aspect = '9:16', assText = null, index = 0 }) {
  const cut = `cut_${index}.mp4`;
  const reframed = `reframed_${index}.mp4`;
  const final = `final_${index}.mp4`;
  const thumb = `thumb_${index}.jpg`;
  const assName = `cap_${index}.ass`;
  const cleanup = [cut, reframed, final, thumb, assName];

  try {
    // 1) Cut without re-encoding where possible (fast). Re-encode if copy fails.
    await run([
      '-ss', String(clip.start),
      '-to', String(clip.end),
      '-i', inputName,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      cut,
    ]).catch(async () => {
      await run(['-ss', String(clip.start), '-to', String(clip.end), '-i', inputName, '-c:v', 'libx264', '-c:a', 'aac', cut]);
    });

    // 2) Reframe / scale to the chosen aspect ratio.
    const vf = reframeFilter(aspect);
    await run(['-i', cut, '-vf', vf, '-c:a', 'aac', '-preset', 'veryfast', reframed]);

    // 3) Burn captions (optional). Needs the .ass written into the FS.
    let toFinalize = reframed;
    if (assText) {
      await ffmpeg.writeFile(assName, new TextEncoder().encode(assText));
      await run(['-i', reframed, '-vf', `ass=${assName}`, '-c:a', 'copy', '-preset', 'veryfast', final]);
      toFinalize = final;
    }

    // 4) Thumbnail from the first frame of the finished clip.
    await run(['-ss', '0', '-i', toFinalize, '-vframes', '1', '-q:v', '3', thumb]);

    const videoData = await ffmpeg.readFile(toFinalize);
    const thumbData = await ffmpeg.readFile(thumb);
    const videoBlob = new Blob([videoData.buffer], { type: 'video/mp4' });
    const thumbBlob = new Blob([thumbData.buffer], { type: 'image/jpeg' });
    return { videoBlob, thumbBlob };
  } finally {
    for (const f of cleanup) await safeDelete(f);
  }
}

/** Probe duration by extracting it from log lines isn't reliable in wasm; the
 *  caller passes duration from the HTMLVideoElement instead. */

// ---------------------------------------------------------------- internals

function reframeFilter(aspect) {
  // "Cover" crop: scale up so the frame is fully covered, then center-crop to
  // the exact target. Safe for any input aspect (portrait, square or landscape).
  switch (aspect) {
    case '1:1':
      return 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080';
    case '16:9':
      // Landscape target: letterbox (pad) to preserve the full original frame.
      return 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
    case '9:16':
    default:
      // Center-crop to 9:16, scaled to 1080x1920 (v1 static crop; v2 = face tracking).
      return 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
  }
}

async function run(args) {
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code} for: ${args.join(' ')}`);
  return code;
}

async function safeDelete(name) {
  try { await ffmpeg.deleteFile(name); } catch { /* not present */ }
}
