// app.js — orchestrator + state machine for ClipForge.
import { validateKey, transcribe, transcribeChunks, pickViralClips, buildTimestampedTranscript } from './groq-api.js';
import * as FF from './ffmpeg-helper.js';
import { buildASS } from './captions.js';
import { BACKEND_URL, COLD_START_HINT_MS } from './config.js';

// ---------------------------------------------------------------- state
const LS_KEY = 'clipforge.apikey';
const LS_SETTINGS = 'clipforge.settings';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const MOBILE_CAP_BYTES = 200 * 1024 * 1024;
const MAX_BACKEND_SECONDS = 1800; // backend's 30-min hard cap
const WARN_BACKEND_SECONDS = 1200; // warn frontend over 20 min

const state = {
  file: null,
  source: 'file',       // 'file' | 'url'
  youtubeUrl: '',
  videoInfo: null,      // { title, durationSeconds, thumbnail, author }
  videoDuration: 0,
  settings: loadSettings(),
  clips: [],            // results, each with objectURLs to revoke later
  cancelled: false,
};

// Track every object URL so we can revoke them and avoid memory leaks.
const liveURLs = new Set();
function makeURL(blob) { const u = URL.createObjectURL(blob); liveURLs.add(u); return u; }
function revokeURL(u) { if (u && liveURLs.has(u)) { URL.revokeObjectURL(u); liveURLs.delete(u); } }
function revokeAll() { for (const u of liveURLs) URL.revokeObjectURL(u); liveURLs.clear(); }

// ---------------------------------------------------------------- dom
const $ = (sel) => document.querySelector(sel);
const screens = {
  upload: $('#screen-upload'),
  processing: $('#screen-processing'),
  results: $('#screen-results'),
};

const PIPELINE_STAGES = [
  { id: 'audio', name: 'Extracting audio' },
  { id: 'transcribe', name: 'Transcribing speech' },
  { id: 'select', name: 'Finding viral moments' },
  { id: 'cut', name: 'Cutting clips' },
  { id: 'caption', name: 'Burning captions' },
];
const DOWNLOAD_STAGE = { id: 'download', name: 'Downloading from YouTube' };

// ---------------------------------------------------------------- init
init();

function init() {
  buildStageList(false);
  wireUpload();
  wireUrlInput();
  wireSettings();
  wirePreview();
  $('#startOverBtn').addEventListener('click', resetToUpload);
  $('#cancelBtn').addEventListener('click', () => { state.cancelled = true; toast('Cancelling…'); });
  window.addEventListener('beforeunload', revokeAll);
}

// ============================ SETTINGS ============================
function loadSettings() {
  const def = { aspect: '9:16', captions: true, clipCount: 5 };
  try { return { ...def, ...JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') }; }
  catch { return def; }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); }

function wireSettings() {
  const modal = $('#settingsModal');
  const open = () => { syncSettingsUI(); openModal(modal); $('#apiKeyInput').focus(); };
  $('#settingsBtn').addEventListener('click', open);
  modal.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', () => closeModal(modal)));

  // API key
  const keyInput = $('#apiKeyInput');
  keyInput.value = localStorage.getItem(LS_KEY) || '';
  keyInput.addEventListener('change', () => {
    const v = keyInput.value.trim();
    if (v) localStorage.setItem(LS_KEY, v); else localStorage.removeItem(LS_KEY);
  });
  $('#toggleKeyBtn').addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
  $('#validateKeyBtn').addEventListener('click', async () => {
    const key = keyInput.value.trim();
    const status = $('#keyStatus');
    if (!key) { setKeyStatus('err', 'Enter a key first'); return; }
    localStorage.setItem(LS_KEY, key);
    setKeyStatus('loading', 'Checking…');
    try {
      await validateKey(key);
      setKeyStatus('ok', '✓ Key works');
    } catch (e) {
      setKeyStatus('err', e.message || 'Validation failed');
    }
  });

  // Aspect ratio segmented control
  $('#aspectToggle').querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.aspect = btn.dataset.aspect;
      saveSettings();
      syncSettingsUI();
    });
  });

  // Captions toggle
  $('#captionsToggle').addEventListener('change', (e) => {
    state.settings.captions = e.target.checked; saveSettings();
  });

  // Clip count slider
  const slider = $('#clipCount');
  slider.addEventListener('input', (e) => {
    state.settings.clipCount = Number(e.target.value);
    $('#clipCountVal').textContent = e.target.value;
    saveSettings();
  });
}

function syncSettingsUI() {
  $('#aspectToggle').querySelectorAll('.seg').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.aspect === state.settings.aspect)));
  $('#captionsToggle').checked = state.settings.captions;
  $('#clipCount').value = state.settings.clipCount;
  $('#clipCountVal').textContent = String(state.settings.clipCount);
}

function setKeyStatus(kind, msg) {
  const el = $('#keyStatus');
  el.className = `key-status ${kind}`;
  el.textContent = msg;
}

// ============================ UPLOAD ============================
function wireUpload() {
  const dz = $('#dropzone');
  const input = $('#fileInput');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { if (input.files[0]) acceptFile(input.files[0]); });

  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) acceptFile(f);
  });

  $('#generateBtn').addEventListener('click', () => { state.source = 'file'; startPipeline(); });
}

function acceptFile(file) {
  const okType = /(mp4|quicktime|webm)/i.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name);
  if (!okType) { toast('Please choose an MP4, MOV or WebM file.', 'err'); return; }

  state.file = file;
  const warn = $('#uploadWarning');
  const sizeMB = file.size / 1048576;
  const isMobile = matchMedia('(max-width: 640px)').matches || /Mobi|Android/i.test(navigator.userAgent);

  warn.hidden = true;
  if (isMobile && file.size > MOBILE_CAP_BYTES) {
    warn.hidden = false;
    warn.textContent = `This file is ${sizeMB.toFixed(0)}MB. Files over 200MB often crash mobile browsers — try a smaller clip or use a desktop.`;
  } else if (sizeMB > 200) {
    warn.hidden = false;
    warn.textContent = `Heads up: ${sizeMB.toFixed(0)}MB is large. Processing may be slow and memory-heavy.`;
  }

  $('#uploadMeta').hidden = false;
  $('#uploadMeta').textContent = `${file.name} · ${sizeMB.toFixed(1)} MB`;
  $('#generateBtn').hidden = false;

  // Choosing a file supersedes any pending YouTube selection.
  $('#ytPreview').hidden = true;
  state.source = 'file';
}

// ============================ YOUTUBE URL ============================
function wireUrlInput() {
  const form = $('#urlForm');
  const input = $('#urlInput');
  const findBtn = $('#findBtn');

  // Without a configured backend the YouTube path can't work — degrade to
  // file-upload-only and tell the user why.
  if (!BACKEND_URL) {
    input.disabled = true;
    input.placeholder = 'YouTube loading not configured — upload a file below';
    findBtn.disabled = true;
    $('#pasteBtn').disabled = true;
  }

  $('#pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { input.value = text.trim(); input.focus(); }
      else toast('Clipboard is empty.', 'err');
    } catch {
      toast('Clipboard blocked — paste manually with Ctrl/Cmd+V.', 'err');
      input.focus();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!BACKEND_URL) return;
    const url = input.value.trim();
    if (!url) { toast('Paste a YouTube URL first.', 'err'); return; }
    if (!looksLikeYouTube(url)) { toast('That doesn’t look like a YouTube URL.', 'err'); return; }

    setFindLoading(true);
    try {
      const info = await fetchVideoInfo(url);
      state.youtubeUrl = url;
      state.videoInfo = info;
      showYtPreview(info);
    } catch (err) {
      showInfoError(err.message);
    } finally {
      setFindLoading(false);
    }
  });

  $('#ytConfirmBtn').addEventListener('click', () => { state.source = 'url'; startPipeline(); });
  $('#ytCancelBtn').addEventListener('click', () => {
    $('#ytPreview').hidden = true;
    $('#infoStatus').hidden = true;
    input.focus();
  });
}

function looksLikeYouTube(url) {
  return /(?:youtube\.com\/(?:watch|shorts|live|embed)|youtu\.be\/)/i.test(url);
}

function setFindLoading(loading) {
  const btn = $('#findBtn');
  btn.disabled = loading;
  $('#findBtnLabel').textContent = loading ? 'Loading…' : 'Find viral clips';
}

// Call POST /info. If it takes longer than COLD_START_HINT_MS, surface the
// Render free-tier cold-start hint.
async function fetchVideoInfo(url) {
  const status = $('#infoStatus');
  status.hidden = false;
  status.className = 'info-status';
  status.textContent = 'Fetching video details…';

  const coldTimer = setTimeout(() => {
    status.className = 'info-status cold';
    status.textContent = 'Waking up the server… (free tier cold start, ~30s)';
  }, COLD_START_HINT_MS);

  try {
    const res = await fetch(`${BACKEND_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
    return data;
  } finally {
    clearTimeout(coldTimer);
  }
}

function showYtPreview(info) {
  $('#infoStatus').hidden = true;
  $('#ytThumb').src = info.thumbnail || '';
  $('#ytTitle').textContent = info.title || 'Untitled video';
  $('#ytAuthor').textContent = info.author || '';
  $('#ytDuration').textContent = fmtDur(Number(info.durationSeconds) || 0);

  const warn = $('#ytWarn');
  const confirm = $('#ytConfirmBtn');
  const dur = Number(info.durationSeconds) || 0;
  if (dur > MAX_BACKEND_SECONDS) {
    warn.hidden = false;
    warn.textContent = 'This video is over 30 minutes — the server will reject it. Try a shorter one.';
    confirm.disabled = true;
  } else if (dur > WARN_BACKEND_SECONDS) {
    warn.hidden = false;
    warn.textContent = 'Over 20 minutes — downloading and processing will take a while.';
    confirm.disabled = false;
  } else {
    warn.hidden = true;
    confirm.disabled = false;
  }
  $('#ytPreview').hidden = false;
}

function showInfoError(msg) {
  const status = $('#infoStatus');
  status.hidden = false;
  status.className = 'info-status err';
  status.textContent = /Failed to fetch|NetworkError|ERR_|Load failed/i.test(msg || '')
    ? 'Couldn’t reach the backend. Check that BACKEND_URL is set in config.js and the server is running.'
    : (msg || 'Could not load that video.');
}

// Fetch /download and stream it into a File, reporting progress. Render's free
// tier may not send Content-Length (chunked), so we degrade to a soft estimate.
async function downloadFromBackend(url, onProgress) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/download?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error('Couldn’t reach the backend to download the video.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 413) throw new Error('That video is over the 30-minute limit.');
    throw new Error(text || `Download failed (${res.status}).`);
  }

  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (state.cancelled) { try { await reader.cancel(); } catch {} throw new Error('__cancelled__'); }
    chunks.push(value);
    received += value.length;
    const mb = (received / 1048576).toFixed(1);
    if (total) {
      onProgress(received / total, `${mb} / ${(total / 1048576).toFixed(1)} MB`);
    } else {
      // Soft asymptotic progress toward 90% when size is unknown.
      onProgress(Math.min(0.9, received / (received + 8 * 1048576)), `${mb} MB`);
    }
  }
  const blob = new Blob(chunks, { type: 'video/mp4' });
  return new File([blob], 'video.mp4', { type: 'video/mp4' });
}

// ============================ PIPELINE ============================
async function startPipeline() {
  const apiKey = (localStorage.getItem(LS_KEY) || '').trim();
  if (!apiKey) { toast('Add your Groq API key in Settings first.', 'err'); openModal($('#settingsModal')); return; }
  const isUrl = state.source === 'url';
  if (isUrl && !state.youtubeUrl) { toast('Paste a YouTube URL first.', 'err'); return; }
  if (!isUrl && !state.file) { toast('Choose a video first.', 'err'); return; }

  state.cancelled = false;
  buildStageList(isUrl);
  resetStages();
  showScreen('processing');

  try {
    // ---- stage: download from YouTube (URL source only) ----
    if (isUrl) {
      setStage('download', 'active', 'Requesting video from server…');
      const file = await downloadFromBackend(state.youtubeUrl, (p, msg) => setStageProgress('download', p, msg));
      state.file = file;
      setStage('download', 'done', `${(file.size / 1048576).toFixed(1)} MB downloaded`);
      checkCancel();
    }

    // Probe duration via a throwaway <video>; fall back to YouTube metadata.
    state.videoDuration = (await probeDuration(state.file)) || Number(state.videoInfo?.durationSeconds) || 0;

    // ---- stage 0: load ffmpeg + write input + extract audio ----
    setStage('audio', 'active', 'Loading FFmpeg.wasm…');
    await FF.loadFFmpeg(() => {}); // logs muted; never print key-bearing data
    setStageProgress('audio', 0.25);
    checkCancel();

    const inputName = await FF.writeInput(state.file);
    setStageProgress('audio', 0.4, 'Decoding audio track…');
    FF.onExecProgress((p) => setStageProgress('audio', 0.4 + p * 0.6));
    let audioBlob = await FF.extractAudio(inputName);
    FF.onExecProgress(null);
    setStage('audio', 'done', `${(audioBlob.size / 1048576).toFixed(1)} MB audio`);
    checkCancel();

    // ---- stage 1: transcribe (chunk if over 25MB) ----
    setStage('transcribe', 'active', 'Sending to Whisper…');
    let transcript;
    if (audioBlob.size <= WHISPER_MAX_BYTES) {
      transcript = await transcribe(apiKey, audioBlob, {
        onProgress: (p, msg) => setStageProgress('transcribe', p, msg),
      });
    } else {
      const chunks = await buildAudioChunks(inputName, state.videoDuration, audioBlob.size);
      transcript = await transcribeChunks(apiKey, chunks, {
        onProgress: (p, msg) => setStageProgress('transcribe', p, msg),
      });
    }
    audioBlob = null; // free
    if (!transcript.words.length) throw new Error('No speech detected in this video.');
    console.log(`[ClipForge] transcript: ${transcript.words.length} words`);
    setStage('transcribe', 'done', `${transcript.words.length} words`);
    checkCancel();

    // ---- stage 2: pick viral clips ----
    setStage('select', 'active', 'Asking Llama for the best moments…');
    setStageProgress('select', 0.4);
    const timestamped = buildTimestampedTranscript(transcript.words);
    const picks = await pickViralClips(apiKey, timestamped, state.settings.clipCount, state.videoDuration);
    if (!picks.length) throw new Error('The AI did not return any usable clips. Try again.');
    console.log('[ClipForge] clips:', picks);
    setStage('select', 'done', `${picks.length} moments found`);
    checkCancel();

    // ---- stage 3 + 4: cut, reframe, caption each clip ----
    setStage('cut', 'active', `0 / ${picks.length} clips`);
    if (state.settings.captions) setStage('caption', 'active', 'Generating caption tracks…');

    const results = [];
    const dims = aspectDims(state.settings.aspect);
    for (let i = 0; i < picks.length; i++) {
      checkCancel();
      const clip = picks[i];
      setStageProgress('cut', i / picks.length, `Clip ${i + 1} / ${picks.length}: ${clip.title}`);

      const assText = state.settings.captions
        ? buildASS(transcript.words, clip.start, clip.end, { width: dims.w, height: dims.h, highlight: true })
        : null;

      FF.onExecProgress((p) => {
        const base = i / picks.length;
        setStageProgress('cut', base + p / picks.length);
        if (assText) setStageProgress('caption', base + p / picks.length);
      });

      const { videoBlob, thumbBlob } = await FF.makeClip(inputName, clip, {
        aspect: state.settings.aspect,
        assText,
        index: i,
      });
      FF.onExecProgress(null);

      results.push({
        ...clip,
        videoURL: makeURL(videoBlob),
        thumbURL: makeURL(thumbBlob),
        videoBlob,
      });
      renderOneCard(results[results.length - 1]); // progressive reveal
    }

    setStage('cut', 'done', `${results.length} clips cut`);
    setStage('caption', 'done', state.settings.captions ? 'Captions burned in' : 'Skipped');

    state.clips = results;
    finishResults(results);
  } catch (err) {
    if (state.cancelled) { resetToUpload(); return; }
    console.error('[ClipForge] pipeline error:', err);
    toast(err.message || 'Something went wrong.', 'err', 6000);
    markStageError(err.message);
  }
}

function checkCancel() { if (state.cancelled) throw new Error('__cancelled__'); }

// Probe duration with a temporary <video>.
function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    v.src = url;
  });
}

// Split audio into <25MB chunks by time. 64kbps ≈ 8KB/s -> ~52min per 25MB,
// so chunking rarely triggers, but we support it for very long videos.
async function buildAudioChunks(inputName, duration, totalBytes) {
  const bytesPerSec = totalBytes / Math.max(duration, 1);
  const safeChunkSecs = Math.max(60, Math.floor((WHISPER_MAX_BYTES * 0.9) / bytesPerSec));
  const chunks = [];
  let idx = 0;
  for (let start = 0; start < duration; start += safeChunkSecs) {
    const dur = Math.min(safeChunkSecs, duration - start);
    setStageProgress('transcribe', start / duration, `Compressing audio part ${idx + 1}…`);
    const blob = await FF.extractAudioChunk(inputName, start, dur, idx);
    chunks.push({ blob, offset: start });
    idx++;
  }
  return chunks;
}

function aspectDims(aspect) {
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  return { w: 1080, h: 1920 };
}

// ============================ STAGE UI ============================
function buildStageList(includeDownload) {
  const ul = $('#stageList');
  const stages = includeDownload ? [DOWNLOAD_STAGE, ...PIPELINE_STAGES] : PIPELINE_STAGES;
  ul.innerHTML = stages.map((s) => `
    <li class="stage" data-stage="${s.id}">
      <span class="stage-icon" aria-hidden="true">${stageIcon(s.id)}</span>
      <span class="stage-body">
        <span class="stage-name">${s.name}</span>
        <span class="stage-detail"></span>
      </span>
      <span class="stage-pct">0%</span>
      <span class="stage-bar"><i></i></span>
    </li>`).join('');
}

function stageIcon() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5 10.1 10.9 5.5 9l4.6-1.4L12 3z"/></svg>`;
}

function resetStages() {
  document.querySelectorAll('.stage').forEach((el) => {
    el.classList.remove('active', 'done', 'error');
    el.querySelector('.stage-detail').textContent = '';
    el.querySelector('.stage-pct').textContent = '0%';
    el.querySelector('.stage-bar > i').style.width = '0%';
  });
}

function stageEl(id) { return document.querySelector(`.stage[data-stage="${id}"]`); }

function setStage(id, status, detail) {
  const el = stageEl(id);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  if (status) el.classList.add(status);
  if (detail != null) el.querySelector('.stage-detail').textContent = detail;
  if (status === 'done') { el.querySelector('.stage-pct').textContent = '100%'; el.querySelector('.stage-bar > i').style.width = '100%'; }
}

function setStageProgress(id, p, detail) {
  const el = stageEl(id);
  if (!el) return;
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  el.querySelector('.stage-pct').textContent = `${pct}%`;
  el.querySelector('.stage-bar > i').style.width = `${pct}%`;
  if (detail != null) el.querySelector('.stage-detail').textContent = detail;
}

function markStageError(msg) {
  const active = document.querySelector('.stage.active');
  if (active) { active.classList.remove('active'); active.classList.add('error'); active.querySelector('.stage-detail').textContent = msg || 'Failed'; }
}

// ============================ RESULTS ============================
function finishResults(results) {
  showScreen('results');
  const avg = Math.round(results.reduce((a, c) => a + c.score, 0) / results.length);
  $('#resultsSub').textContent = `${results.length} clips · avg virality ${avg} · ${state.settings.aspect}`;
}

function renderOneCard(clip) {
  // Ensure results screen exists; cards are appended live during processing too.
  const grid = $('#clipGrid');
  if (clip._rendered) return;
  clip._rendered = true;
  grid.appendChild(buildCard(clip));
}

function buildCard(clip) {
  const card = document.createElement('article');
  card.className = 'clip-card';
  const cls = clip.score >= 90 ? 'score-hot' : clip.score >= 70 ? 'score-blue' : 'score-lav';
  const arClass = state.settings.aspect === '1:1' ? 'ar-1-1' : state.settings.aspect === '16:9' ? 'ar-16-9' : '';

  card.innerHTML = `
    <div class="thumb-wrap ${arClass}">
      <img alt="" src="${clip.thumbURL}" loading="lazy" />
      <span class="score-badge ${cls}">${clip.score}</span>
      <span class="dur-badge">${fmtDur(clip.end - clip.start)}</span>
      <button class="play-overlay" aria-label="Preview clip">
        <span class="play-btn">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </button>
    </div>
    <div class="card-body">
      <h3 class="card-title"></h3>
      <p class="card-reason"></p>
      <div class="card-actions">
        <button class="pill-btn small preview">Preview</button>
        <button class="pill-btn small dl">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
          Download
        </button>
      </div>
    </div>`;

  card.querySelector('.card-title').textContent = clip.title;
  card.querySelector('.card-reason').textContent = clip.reasoning;
  card.querySelector('.play-overlay').addEventListener('click', () => openPreview(clip));
  card.querySelector('.preview').addEventListener('click', () => openPreview(clip));
  card.querySelector('.dl').addEventListener('click', () => downloadClip(clip));
  return card;
}

function downloadClip(clip) {
  const a = document.createElement('a');
  const safe = clip.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'clip';
  a.href = clip.videoURL;
  a.download = `${safe}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============================ PREVIEW MODAL ============================
function wirePreview() {
  const modal = $('#previewModal');
  modal.querySelectorAll('[data-close-preview]').forEach((el) => el.addEventListener('click', closePreview));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePreview(); closeAnyModal(); } });
}

function openPreview(clip) {
  const modal = $('#previewModal');
  const v = $('#previewVideo');
  v.src = clip.videoURL;
  openModal(modal);
  v.play().catch(() => {});
}

function closePreview() {
  const modal = $('#previewModal');
  if (modal.hidden) return;
  const v = $('#previewVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  closeModal(modal);
}

// ============================ SCREEN / MODAL HELPERS ============================
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('is-active'));
  screens[name].classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetToUpload() {
  // Revoke all blob URLs to free memory, clear the grid.
  closePreview();
  revokeAll();
  state.clips = [];
  state.file = null;
  state.source = 'file';
  state.youtubeUrl = '';
  state.videoInfo = null;
  $('#clipGrid').innerHTML = '';
  $('#ytPreview').hidden = true;
  $('#infoStatus').hidden = true;
  $('#generateBtn').hidden = true;
  $('#uploadMeta').hidden = true;
  $('#uploadWarning').hidden = true;
  showScreen('upload');
}

function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }
function closeAnyModal() { document.querySelectorAll('.modal:not([hidden])').forEach((m) => { if (m.id !== 'previewModal') m.hidden = true; }); }

// ============================ MISC UI ============================
let toastTimer = null;
function toast(msg, kind = '', ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => (el.hidden = true), 300); }, ms);
}

function fmtDur(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Sync settings UI once at load so toggles reflect saved prefs.
syncSettingsUI();
