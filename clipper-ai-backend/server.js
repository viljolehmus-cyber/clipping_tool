import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";

const app = express();

// In production, set ALLOWED_ORIGIN to your GitHub Pages origin
// (e.g. https://yourusername.github.io) to lock CORS down. Defaults to open.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const MAX_SECONDS = 1800; // 30 min hard cap — long videos kill the free tier

app.get("/health", (_, res) => res.json({ ok: true }));

// Video metadata (title, duration, thumbnail, author). The frontend calls this
// first so it can show a preview card and warn on long videos.
app.post("/info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: "Invalid YouTube URL" });
    const info = await ytdl.getInfo(url);
    const { videoDetails } = info;
    res.json({
      title: videoDetails.title,
      durationSeconds: Number(videoDetails.lengthSeconds),
      thumbnail: videoDetails.thumbnails.at(-1)?.url,
      author: videoDetails.author?.name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream the MP4 back. Pick a progressive (audio+video) mp4 so the browser /
// FFmpeg.wasm gets a single self-contained file without remuxing.
app.get("/download", async (req, res) => {
  try {
    const { url } = req.query;
    if (!ytdl.validateURL(url)) return res.status(400).send("Invalid URL");

    const info = await ytdl.getInfo(url);
    if (Number(info.videoDetails.lengthSeconds) > MAX_SECONDS) {
      return res.status(413).send("Video too long (max 30 min on free tier)");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="video.mp4"`);

    const stream = ytdl(url, {
      quality: "highest",
      filter: (f) => f.container === "mp4" && f.hasAudio && f.hasVideo,
    });

    // If ytdl errors mid-stream, surface it instead of hanging the socket.
    stream.on("error", (err) => {
      if (!res.headersSent) res.status(500).send(err.message);
      else res.destroy(err);
    });

    stream.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`clipper-ai-backend on ${PORT}`));
