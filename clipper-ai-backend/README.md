# clipper-ai-backend

Tiny Node.js + Express service with one job: accept a YouTube URL and stream the
MP4 back to the ClipForge frontend. The browser can't download from YouTube
directly (CORS + ToS), so this server fronts [`@distube/ytdl-core`] — the
actively-maintained ytdl fork (don't use plain `ytdl-core`, it breaks often).

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/health`   | `{ ok: true }` liveness check |
| POST   | `/info`     | Body `{ url }` → `{ title, durationSeconds, thumbnail, author }` |
| GET    | `/download` | `?url=…` → streams `video/mp4` (rejects videos > 30 min with 413) |

## Run locally

```bash
npm install
npm start            # listens on PORT (default 3000)

curl http://localhost:3000/health
curl -X POST http://localhost:3000/info \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Deploy to Render (free tier)

1. Push **this folder** to its own GitHub repo (or point Render at the
   `clipper-ai-backend` subdirectory via the service's **Root Directory** setting).
2. render.com → **New → Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Free tier is fine. Note the URL, e.g. `https://clipper-ai-backend.onrender.com`.
5. Paste that URL into the frontend's `config.js` as `BACKEND_URL`.

> Render's free tier sleeps after ~15 min idle; the first request after sleep
> takes ~30s to spin up. The frontend shows a "Waking up the server…" message
> when `/info` takes longer than 5s.

## Production CORS

CORS is open by default for easy setup. Once the frontend is live, lock it down
to your GitHub Pages origin by setting an env var on Render:

```
ALLOWED_ORIGIN = https://yourusername.github.io
```

[`@distube/ytdl-core`]: https://github.com/distubejs/ytdl-core
