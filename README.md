# ClipForge — browser-based viral clip generator

Turn a long video (podcast, interview, vlog) into short, vertical, caption-burned
clips — entirely in the browser. AI finds the most viral moments, cuts them to
15–60s, reframes to 9:16, and burns in TikTok-style auto-captions.

No frameworks, no build step. Pure HTML/CSS/vanilla JS, deployable to GitHub Pages.

## How it works

1. **Extract audio** — FFmpeg.wasm pulls a compressed mono 16 kHz / 64 kbps MP3
   (kept under Groq Whisper's 25 MB limit; auto-chunked if a video is long enough
   to exceed it).
2. **Transcribe** — Groq `whisper-large-v3` with word-level timestamps
   (`response_format: "verbose_json"`, `timestamp_granularities: ["word"]`).
3. **Find viral moments** — Groq `llama-3.3-70b-versatile` reads the timestamped
   transcript and returns the N best clips as JSON (start/end, title, score, reasoning).
4. **Cut + reframe + caption** — for each clip, FFmpeg.wasm cuts the range,
   center-crops/scales to the chosen aspect ratio, burns an `.ass` caption track,
   and grabs a thumbnail.

Everything runs client-side. The only network calls are to the Groq API with
**your own** API key (stored in `localStorage`, never logged).

## Setup

1. Get a free Groq API key at <https://console.groq.com/keys>.
2. Open the app, click the gear icon, paste your key, and hit **Validate key**
   (this does a tiny hello-world Llama call to confirm it works).
3. Drop a video, pick your settings, and **Generate viral clips**.

### Run locally

FFmpeg.wasm needs cross-origin isolation (SharedArrayBuffer). The included
`coi-serviceworker.js` provides it client-side, but you still need to serve the
files over HTTP (not `file://`):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deploy to GitHub Pages

Push to your repo and enable Pages (Settings → Pages → deploy from branch).
GitHub Pages can't send COOP/COEP headers, so `coi-serviceworker.js` is loaded as
the **very first** script in `<head>` to enable cross-origin isolation client-side.
The `.nojekyll` file ensures every asset is served verbatim.

## Settings

- **Groq API key** — password field with show/hide, validated on demand.
- **Aspect ratio** — 9:16 (default), 1:1, or 16:9.
- **Captions** — burn-in on/off.
- **Clip count** — 3–10.

## Caption style

TikTok-style ASS subtitles generated from the word timestamps: bold uppercase,
white with a thick black outline + drop shadow, ~14% of video height, centered
and ~70% down the frame, 1–3 words at a time, with the active word highlighted in
electric blue (`#0066FF`).

## Notes, limits & gotchas

- **Whisper input cap is 25 MB.** Audio is compressed hard (64 kbps mono 16 kHz)
  and chunked by time if a video is long enough to still exceed it.
- **Large videos can crash mobile.** There's a friendly 200 MB warning on mobile.
- **FFmpeg.wasm is slow.** A 10-minute video may take 3–5 minutes; the processing
  screen shows realistic per-stage progress so it never looks frozen.
- **Memory.** Every `URL.createObjectURL()` is tracked and revoked on reset /
  unload to avoid leaks.
- **Reframing is a center crop (v1).** Real face-tracking reframing would be a v2
  upgrade using [MediaPipe](https://developers.google.com/mediapipe) face
  detection to keep the speaker centered instead of a static center crop.

## File structure

```
index.html            shell with all screen sections + importmap for FFmpeg.wasm
styles.css            theme (CSS custom properties), glassmorphism, animations
app.js                orchestrator + state machine
ffmpeg-helper.js      wraps FFmpeg.wasm: load, extract audio, cut, reframe, caption, thumbnail
groq-api.js           Whisper transcription + Llama clip selection
captions.js           ASS subtitle generator from word timestamps
coi-serviceworker.js  enables SharedArrayBuffer (cross-origin isolation) on GitHub Pages
```

## Tech

Vanilla HTML/CSS/JS · [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
0.12.x (loaded from unpkg) · [Groq API](https://console.groq.com).
