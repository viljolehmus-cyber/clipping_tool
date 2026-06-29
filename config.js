// config.js — deployment configuration for the ClipForge frontend.
//
// Set BACKEND_URL to your deployed clipper-ai-backend (Render) URL once it's
// live, e.g. "https://clipper-ai-backend.onrender.com". No trailing slash.
//
// Leave it as the localhost default for local development against
// `npm start` in /clipper-ai-backend. If it's left blank/unset, the YouTube
// URL feature is disabled in the UI and only file upload works.
export const BACKEND_URL = "http://localhost:3000";

// Show the "Waking up the server…" hint if /info takes longer than this.
// Render's free tier cold-starts in ~30s after 15 min idle.
export const COLD_START_HINT_MS = 5000;
