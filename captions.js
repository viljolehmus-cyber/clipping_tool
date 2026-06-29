// captions.js — Generate a TikTok-style ASS subtitle file from word timestamps.
// Words are grouped 1–3 at a time and swapped as they're spoken. The currently
// spoken word can be highlighted in electric blue.

const HIGHLIGHT = '&H00FF6600'; // ASS is &HAABBGGRR -> #0066FF
const WHITE = '&H00FFFFFF';
const OUTLINE = '&H00000000';

/**
 * Build an .ass file string for a single clip.
 * @param {Array<{word,start,end}>} words  word timings (GLOBAL seconds)
 * @param {number} clipStart  clip start in global seconds (subtracted -> clip-local)
 * @param {number} clipEnd    clip end in global seconds
 * @param {object} opts        { width, height, highlight, wordsPerGroup }
 */
export function buildASS(words, clipStart, clipEnd, opts = {}) {
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const highlight = opts.highlight !== false;
  const perGroup = opts.wordsPerGroup || 3;

  // ~14% of video height, in points (ASS uses the script resolution as px).
  const fontSize = Math.round(height * 0.14);
  const outline = Math.max(3, Math.round(height * 0.004)); // ~thick black outline
  const shadow = Math.max(1, Math.round(height * 0.0015));
  // Position ~70% from top. With Alignment 2 (bottom-center) we set MarginV from bottom.
  const marginV = Math.round(height * 0.30);

  // Keep only words inside the clip, rebased to clip-local time.
  const local = words
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      word: clean(w.word),
      start: Math.max(0, w.start - clipStart),
      end: Math.max(0, Math.min(w.end, clipEnd) - clipStart),
    }))
    .filter((w) => w.word);

  const groups = groupWords(local, perGroup);
  const dialogue = groups.map((g) => renderGroup(g, highlight)).join('\n');

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop,Arial Black,${fontSize},${WHITE},${HIGHLIGHT},${OUTLINE},&H64000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue}
`;
}

// ---------------------------------------------------------------- helpers

function groupWords(words, perGroup) {
  const groups = [];
  for (let i = 0; i < words.length; i += perGroup) {
    const slice = words.slice(i, i + perGroup);
    if (!slice.length) continue;
    groups.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      words: slice,
    });
  }
  // Prevent zero/negative durations & overlaps between consecutive groups.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].end <= groups[i].start) groups[i].end = groups[i].start + 0.4;
    if (i + 1 < groups.length && groups[i].end > groups[i + 1].start) {
      groups[i].end = groups[i + 1].start;
    }
  }
  return groups;
}

/**
 * Render one group as one Dialogue line. If highlighting is on, we emit one
 * line per word so the active word turns blue while the rest stay white,
 * giving the karaoke-style "pop" without complex \k tags.
 */
function renderGroup(group, highlight) {
  if (!highlight) {
    const text = group.words.map((w) => w.word).join(' ');
    return `Dialogue: 0,${t(group.start)},${t(group.end)},Pop,,0,0,0,,${text.toUpperCase()}`;
  }
  const lines = [];
  for (let i = 0; i < group.words.length; i++) {
    const w = group.words[i];
    const start = w.start;
    const end = i + 1 < group.words.length ? group.words[i + 1].start : group.end;
    if (end <= start) continue;
    const text = group.words
      .map((ww, j) => {
        const up = ww.word.toUpperCase();
        return j === i ? `{\\c${HIGHLIGHT}}${up}{\\c${WHITE}}` : up;
      })
      .join(' ');
    lines.push(`Dialogue: 0,${t(start)},${t(end)},Pop,,0,0,0,,${text}`);
  }
  return lines.join('\n');
}

function clean(word) {
  // Strip control chars and ASS-breaking braces/newlines.
  return String(word).replace(/[{}\\\n\r]/g, '').trim();
}

// Seconds -> ASS time "H:MM:SS.cs" (centiseconds).
function t(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const cc = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}
