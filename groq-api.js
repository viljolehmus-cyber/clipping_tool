// groq-api.js — Whisper transcription + Llama clip selection wrappers.
// The user's API key is passed in per-call; it is never logged here.

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const WHISPER_MODEL = 'whisper-large-v3';
const LLAMA_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25MB hard limit

/**
 * Hello-world call used by the settings modal to validate a key.
 * Returns true on success, throws with a readable message otherwise.
 */
export async function validateKey(apiKey) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 4,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return !!data.choices?.[0]?.message;
}

/**
 * Transcribe an audio Blob with word-level timestamps.
 * If the blob exceeds Groq's 25MB limit it is split into time-based chunks
 * (caller passes a `chunker` that can re-encode sub-ranges) — see app.js.
 * Returns a flat array of { word, start, end } plus the full text.
 */
export async function transcribe(apiKey, audioBlob, { onProgress } = {}) {
  if (audioBlob.size > WHISPER_MAX_BYTES) {
    throw new Error(
      `Audio is ${(audioBlob.size / 1048576).toFixed(1)}MB, over Groq's 25MB limit. ` +
      `Try a shorter video.`
    );
  }
  onProgress?.(0.1, 'Uploading audio to Whisper…');

  const form = new FormData();
  form.append('file', audioBlob, 'audio.mp3');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('temperature', '0');

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  onProgress?.(0.85, 'Receiving transcript…');
  if (!res.ok) throw new Error(await readError(res));

  const data = await res.json();
  const words = normalizeWords(data);
  onProgress?.(1, 'Transcript ready');
  return { text: data.text || '', words, duration: data.duration };
}

/**
 * Transcribe several audio chunks (each under the size limit) and stitch the
 * word timestamps back onto the global timeline using each chunk's offset.
 * `chunks` = [{ blob, offset }] where offset is seconds from video start.
 */
export async function transcribeChunks(apiKey, chunks, { onProgress } = {}) {
  const allWords = [];
  let fullText = '';
  for (let i = 0; i < chunks.length; i++) {
    const { blob, offset } = chunks[i];
    onProgress?.(i / chunks.length, `Transcribing part ${i + 1} of ${chunks.length}…`);
    const { words, text } = await transcribe(apiKey, blob);
    for (const w of words) {
      allWords.push({ word: w.word, start: w.start + offset, end: w.end + offset });
    }
    fullText += (fullText ? ' ' : '') + text;
  }
  onProgress?.(1, 'Transcript ready');
  return { text: fullText, words: allWords };
}

/**
 * Ask Llama to pick the N most viral moments from the transcript.
 * Returns a validated array of clips sorted by score (desc).
 */
export async function pickViralClips(apiKey, transcriptText, count, videoDuration) {
  const prompt = buildClipPrompt(transcriptText, count);
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(await readError(res));

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const clips = parseClips(raw);
  return sanitizeClips(clips, videoDuration);
}

// ---------------------------------------------------------------- helpers

function buildClipPrompt(transcript, count) {
  return `You are a viral content expert who studies what makes short-form videos go viral on TikTok, Reels, and Shorts.

Analyze this transcript with timestamps and find the ${count} most viral-worthy moments. Look for:
- Strong emotional hooks (surprise, controversy, vulnerability, awe)
- Quotable one-liners that work without context
- Self-contained mini-stories with clear setup + payoff
- Counter-intuitive insights or hot takes
- High-energy moments (laughter, excitement, intensity)

Each clip must:
- Be 15-60 seconds long
- Start and end at natural sentence boundaries
- Not overlap with other clips
- Make sense as a standalone short

Return ONLY valid JSON, no markdown, no preamble:
{
  "clips": [
    {
      "start_time": 123.4,
      "end_time": 167.2,
      "title": "catchy 5-8 word hook",
      "score": 87,
      "reasoning": "one sentence why this works"
    }
  ]
}

TRANSCRIPT (word: start-end seconds):
${transcript}`;
}

/**
 * Build a compact, timestamped transcript string for the Llama prompt.
 * Groups words into ~sentence-ish lines so the model can reason about
 * boundaries while keeping the token count manageable.
 */
export function buildTimestampedTranscript(words) {
  if (!words.length) return '';
  const lines = [];
  let buf = [];
  let lineStart = words[0].start;
  for (const w of words) {
    buf.push(w.word);
    const isBoundary = /[.!?]$/.test(w.word.trim());
    if (isBoundary || buf.length >= 18) {
      const lineEnd = w.end;
      lines.push(`[${fmt(lineStart)}-${fmt(lineEnd)}] ${buf.join(' ').trim()}`);
      buf = [];
      lineStart = w.end;
    }
  }
  if (buf.length) lines.push(`[${fmt(lineStart)}-${fmt(words[words.length - 1].end)}] ${buf.join(' ').trim()}`);
  return lines.join('\n');
}

function fmt(s) { return Number(s).toFixed(1); }

function normalizeWords(data) {
  // verbose_json returns a top-level `words` array when word granularity is set.
  if (Array.isArray(data.words) && data.words.length) {
    return data.words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
  }
  // Fallback: derive coarse word timings from segments.
  const out = [];
  for (const seg of data.segments || []) {
    const toks = (seg.text || '').trim().split(/\s+/).filter(Boolean);
    const span = (seg.end - seg.start) / Math.max(toks.length, 1);
    toks.forEach((t, i) => out.push({ word: t, start: seg.start + i * span, end: seg.start + (i + 1) * span }));
  }
  return out;
}

function parseClips(raw) {
  let text = raw.trim();
  // Strip accidental markdown fences if the model added them.
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not parse clip selection from the AI response.');
    obj = JSON.parse(match[0]);
  }
  const clips = Array.isArray(obj) ? obj : obj.clips;
  if (!Array.isArray(clips)) throw new Error('AI response did not contain a clips array.');
  return clips;
}

function sanitizeClips(clips, videoDuration) {
  const cleaned = [];
  for (const c of clips) {
    let start = Number(c.start_time);
    let end = Number(c.end_time);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    if (videoDuration) end = Math.min(end, videoDuration);
    // Enforce 15–60s window.
    let dur = end - start;
    if (dur < 15) end = start + 15;
    if (dur > 60) end = start + 60;
    if (videoDuration && end > videoDuration) { end = videoDuration; start = Math.max(0, end - 60); }
    if (end - start < 5) continue;
    cleaned.push({
      start: Math.max(0, start),
      end,
      title: String(c.title || 'Untitled clip').trim().slice(0, 80),
      score: clampScore(c.score),
      reasoning: String(c.reasoning || '').trim().slice(0, 160),
    });
  }
  // Drop overlaps, keeping higher-scored clips.
  cleaned.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of cleaned) {
    if (kept.some((k) => c.start < k.end && c.end > k.start)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => b.score - a.score);
}

function clampScore(s) {
  let n = Math.round(Number(s));
  if (!isFinite(n)) n = 70;
  return Math.max(1, Math.min(100, n));
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.error?.message || JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  if (res.status === 401) return 'Invalid Groq API key (401). Check it in Settings.';
  if (res.status === 429) return 'Groq rate limit hit (429). Wait a moment and retry.';
  if (res.status === 413) return 'Audio file too large for Groq (413).';
  return `Groq API error ${res.status}: ${detail}`;
}
