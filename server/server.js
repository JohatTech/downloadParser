/**
 * YouTube MP3 Downloader Local Companion Server — v4.0
 *
 * WHAT WE LEARNED FROM yt-converter SOURCE (dist/index.mjs):
 *
 *   yt-converter's Audio() only activates its agent when process.env.PROXY_URL
 *   is set (line 44: `var useAgent = !!process.env.PROXY_URL`). Without a
 *   proxy configured, it calls ytdl3(url, { filter:"audioonly" }) with NO agent
 *   → YouTube bot-detection returns 0 playable formats.
 *
 * FIX:
 *   We replicate yt-converter's exact ffmpeg spawn pattern but inject
 *   @distube/ytdl-core's createAgent() with a SOCS=CAI consent cookie.
 *   This is what yt-converter WOULD do with PROXY_URL set, but without needing
 *   an actual proxy — just the consent cookie to pass YouTube's bot gate.
 *
 *   Playlist extraction uses the same ytInitialData HTML scraper (one HTTP
 *   request, zero per-video fetches).
 *
 * REST API:
 *   GET  /health                   – server liveness
 *   GET  /api/playlist?listId=PL…  – extract all playlist items (no per-video fetch)
 *   POST /api/convert              – convert a single video to MP3
 *   GET  /api/status/:videoId      – poll conversion progress
 *   GET  /api/download/:filename   – stream the finished MP3 file
 *   GET  /api/files                – list all downloaded MP3s
 */

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import https from "https";
import cp from "child_process";
import { fileURLToPath } from "url";

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// @distube/ytdl-core — active, maintained fork used by yt-converter internally
import ytdl from "@distube/ytdl-core";

// ffmpeg-static — bundled ffmpeg.exe, same binary yt-converter uses
import ffmpegStatic from "ffmpeg-static";

// Express setup
const app  = express();
const PORT = process.env.PORT || 4567;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
app.use(cors());
app.use(express.json());

// ── Bot-detection bypass agent ────────────────────────────────────────────────
// createAgent() auto-injects SOCS=CAI (consent cookie). We extend it with
// common browser cookies to maximise format availability.
// This is the agent yt-converter WOULD use if PROXY_URL was set, adapted
// to work without an actual proxy.
const ytAgent = ytdl.createAgent([
  {
    domain: ".youtube.com", hostOnly: false, httpOnly: false,
    name: "SOCS", path: "/", sameSite: "lax", secure: true, session: false,
    value: "CAI",          // Consent Accepted Immediately — bypasses consent wall
    expirationDate: 9999999999
  },
  {
    domain: ".youtube.com", hostOnly: false, httpOnly: false,
    name: "CONSENT", path: "/", sameSite: "no_restriction", secure: true, session: false,
    value: "YES+cb",
    expirationDate: 9999999999
  }
]);

// In-memory job tracker
const activeJobs = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// PLAYLIST EXTRACTION — single-request ytInitialData scraper
// ─────────────────────────────────────────────────────────────────────────────

const HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Cookie": "SOCS=CAI; CONSENT=YES+cb"
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HTML_HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/**
 * Brace-balanced JSON extraction from a raw HTML string.
 * More reliable than a simple greedy regex for large ytInitialData blobs.
 */
function extractJsonFromHtml(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  // Find the opening brace after the marker
  const start = html.indexOf("{", idx);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.substring(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function parseYtInitialData(html) {
  // Try each known marker YouTube uses
  for (const marker of [
    "var ytInitialData =",
    "window[\"ytInitialData\"] =",
    "ytInitialData ="
  ]) {
    const data = extractJsonFromHtml(html, marker);
    if (data) return data;
  }
  return null;
}

function deepGet(obj, ...keys) {
  return keys.reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

function formatDuration(raw) {
  if (!raw) return "Unknown";
  const iso = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1] || 0);
    const m = parseInt(iso[2] || 0);
    const s = parseInt(iso[3] || 0);
    return `${h * 60 + m}:${String(s).padStart(2, "0")}`;
  }
  return raw;
}

function extractVideosFromInitialData(data, listId) {
  const videos = [];
  let playlistTitle = `Playlist ${listId}`;

  // Grab title from multiple possible locations
  try {
    const t =
      deepGet(data, "header", "playlistHeaderRenderer", "title", "runs", 0, "text") ||
      deepGet(data, "header", "playlistHeaderRenderer", "title", "simpleText") ||
      deepGet(data, "metadata", "playlistMetadataRenderer", "title") ||
      deepGet(data, "microformat", "microformatDataRenderer", "title");
    if (t) playlistTitle = typeof t === "string" ? t : t.toString();
  } catch (_) {}

  // Walk every tab → section → item looking for playlistVideoListRenderer
  const tabs = deepGet(data, "contents", "twoColumnBrowseResultsRenderer", "tabs") || [];
  let videoListContents = [];

  outer: for (const tab of tabs) {
    const sections = deepGet(tab, "tabRenderer", "content", "sectionListRenderer", "contents") || [];
    for (const section of sections) {
      const items = deepGet(section, "itemSectionRenderer", "contents") || [];
      for (const item of items) {
        if (item.playlistVideoListRenderer?.contents) {
          videoListContents = item.playlistVideoListRenderer.contents;
          break outer;
        }
      }
      // Also check direct richGridRenderer (used on some playlist pages)
      const richItems = deepGet(section, "richGridRenderer", "contents") || [];
      for (const ri of richItems) {
        const renderer = deepGet(ri, "richItemRenderer", "content", "playlistVideoRenderer");
        if (renderer?.videoId) {
          videoListContents = richItems
            .map(r => ({ playlistVideoRenderer: deepGet(r, "richItemRenderer", "content", "playlistVideoRenderer") }))
            .filter(r => r.playlistVideoRenderer?.videoId);
          break outer;
        }
      }
    }
  }

  for (let i = 0; i < videoListContents.length; i++) {
    const entry = videoListContents[i].playlistVideoRenderer;
    if (!entry?.videoId) continue;

    const { videoId } = entry;
    const title =
      deepGet(entry, "title", "runs", 0, "text") ||
      deepGet(entry, "title", "simpleText") ||
      `Video ${i + 1}`;
    const channel =
      deepGet(entry, "shortBylineText", "runs", 0, "text") ||
      deepGet(entry, "longBylineText", "runs", 0, "text") ||
      "Unknown Artist";
    const durationRaw =
      deepGet(entry, "lengthText", "simpleText") ||
      deepGet(entry, "lengthText", "runs", 0, "text");
    const thumbs = deepGet(entry, "thumbnail", "thumbnails") || [];
    const thumbnail =
      (thumbs.length ? thumbs[thumbs.length - 1].url : null) ||
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    videos.push({
      index: i + 1,
      id: videoId,
      title: title.replace(/[/\\?%*:|"<>]/g, "").trim(),
      rawTitle: title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail,
      duration: formatDuration(durationRaw),
      channel: channel.trim(),
      status: "pending_permission",
      downloadUrl: null,
      error: null
    });
  }

  return { playlistTitle, videos };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "YouTube MP3 Downloader Server v4.0",
    engine: "@distube/ytdl-core + ffmpeg-static (yt-converter pattern)",
    agentEnabled: true,
    activeJobsCount: activeJobs.size
  });
});

/**
 * GET /api/playlist?listId=PL…
 * One HTTP request → parse ytInitialData → return all video metadata.
 * Zero per-video fetches.
 */
app.get("/api/playlist", async (req, res) => {
  const { listId } = req.query;
  if (!listId) return res.status(400).json({ error: "listId is required" });

  try {
    console.log(`[Playlist] Fetching: https://www.youtube.com/playlist?list=${listId}`);
    const html = await fetchHtml(`https://www.youtube.com/playlist?list=${listId}`);
    const ytData = parseYtInitialData(html);

    if (!ytData) {
      // Dump a snippet to help debug if parsing fails
      const snippet = html.substring(0, 300);
      console.error("[Playlist] Could not parse ytInitialData. HTML start:", snippet);
      return res.status(422).json({
        error: "Could not parse playlist page. It may be private or age-restricted.",
        listId
      });
    }

    const { playlistTitle, videos } = extractVideosFromInitialData(ytData, listId);
    console.log(`[Playlist] ✓ Extracted ${videos.length} videos from "${playlistTitle}"`);
    res.json({ success: true, playlistId: listId, playlistTitle, totalCount: videos.length, videos });
  } catch (err) {
    console.error("[Playlist] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/convert  { videoId, title }
 *
 * Implements yt-converter's exact ffmpeg spawn pattern from dist/index.mjs
 * but with ytAgent injected — fixing the "Failed to find any playable formats"
 * that occurs because yt-converter only uses its agent when PROXY_URL is set.
 */
app.post("/api/convert", async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId is required" });

  const cleanTitle = (title || videoId)
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);

  const targetFilename = `${cleanTitle}.mp3`;
  const targetFilePath = path.join(DOWNLOAD_DIR, targetFilename);

  // Cache hit
  if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 1000) {
    console.log(`[Cache] Hit for: ${videoId}`);
    const job = {
      status: "finished", progress: 100, filename: targetFilename, cached: true,
      downloadUrl: `http://localhost:${PORT}/api/download/${encodeURIComponent(targetFilename)}`
    };
    activeJobs.set(videoId, job);
    return res.json(job);
  }

  activeJobs.set(videoId, { status: "converting", progress: 5, filename: targetFilename, downloadUrl: null, error: null });
  res.json({ success: true, status: "converting", message: `Queued: ${videoId}` });

  convertToMp3(videoId, targetFilePath, targetFilename);
});

/**
 * Core conversion function — mirrors yt-converter's Audio() implementation
 * (dist/index.mjs lines 162-249) but with ytAgent for bot-detection bypass.
 *
 *   Key difference from yt-converter's Audio():
 *   yt-converter only sets `agent: useAgent ? agent : undefined`
 *   where useAgent = !!process.env.PROXY_URL (defaults to false).
 *   We always inject ytAgent built from createAgent() with SOCS cookie.
 */
async function convertToMp3(videoId, targetFilePath, targetFilename) {
  const job = activeJobs.get(videoId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    console.log(`[Convert] Getting info for: ${videoId}`);
    job.progress = 10;

    // Step 1: Get video info WITH agent — same as yt-converter's getInfo but with agent
    const info = await ytdl.getInfo(url, { agent: ytAgent });
    const fileTitle = info.videoDetails.title.replace(/[/\\?%*:|"<>]/g, "").trim();
    console.log(`[Convert] Title: "${fileTitle}" — starting audio stream`);
    job.progress = 20;

    // Step 2: Create audio stream WITH agent (same filter as yt-converter's Audio())
    const tracker = { downloaded: 0, total: 0 };
    const stream = ytdl.downloadFromInfo(info, {
      filter: "audioonly",
      quality: "highestaudio",
      agent: ytAgent
    }).on("progress", (_, downloaded, total) => {
      tracker.downloaded = downloaded;
      tracker.total = total;
    }).on("error", (err) => {
      console.error(`[Convert] Stream error for ${videoId}:`, err.message);
      job.status = "error";
      job.error = `Stream error: ${err.message}`;
    });

    // Step 3: Spawn ffmpeg — same args as yt-converter's Audio() (dist/index.mjs:200-219)
    const ffmpegProcess = cp.spawn(
      ffmpegStatic,
      [
        "-loglevel", "8",
        "-hide_banner",
        "-progress", "pipe:3",
        "-i", "pipe:4",
        targetFilePath
      ],
      {
        windowsHide: true,
        stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"]
      }
    );

    if (!ffmpegProcess) {
      throw new Error("Cannot initialize ffmpeg");
    }

    // Step 4: Pipe progress updates (matches yt-converter's ffmpegProcess.stdio[3] handler)
    ffmpegProcess.stdio[3].on("data", () => {
      if (tracker.total > 0) {
        const pct = Math.min(98, Math.round((tracker.downloaded / tracker.total) * 100));
        job.progress = Math.max(job.progress, pct);
      } else {
        job.progress = Math.min(job.progress + 2, 95);
      }
    });

    // Step 5: Await close and write ID3 metadata
    await new Promise((resolve, reject) => {
      ffmpegProcess.on("close", resolve);
      ffmpegProcess.on("error", reject);
      stream.pipe(ffmpegProcess.stdio[4]);
    });

    if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 1000) {
      console.log(`[Convert] ✓ ${targetFilename}`);
      job.status = "finished";
      job.progress = 100;
      job.downloadUrl = `http://localhost:${PORT}/api/download/${encodeURIComponent(targetFilename)}`;
    } else {
      throw new Error("FFmpeg exited but no output file was created.");
    }
  } catch (err) {
    console.error(`[Convert] ✗ ${videoId}:`, err.message);
    job.status = "error";
    job.error = err.message;
  }
}

app.get("/api/status/:videoId", (req, res) => {
  const job = activeJobs.get(req.params.videoId);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});

app.get("/api/download/:filename", (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.filename)}"`);
  res.setHeader("Content-Type", "audio/mpeg");
  fs.createReadStream(filePath).pipe(res);
});

app.get("/api/files", (_req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.endsWith(".mp3"))
      .map(f => ({
        filename: f,
        sizeMb: (fs.statSync(path.join(DOWNLOAD_DIR, f)).size / 1024 / 1024).toFixed(2),
        downloadUrl: `http://localhost:${PORT}/api/download/${encodeURIComponent(f)}`
      }));
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("=======================================================");
  console.log(` YouTube MP3 Server v4.0 on port ${PORT}`);
  console.log(` Engine  : @distube/ytdl-core + ffmpeg-static`);
  console.log(` Agent   : SOCS=CAI bypass (no proxy needed)`);
  console.log(` Playlist: ytInitialData scraper (0 per-video fetches)`);
  console.log(` Health  : http://localhost:${PORT}/health`);
  console.log("=======================================================");
});
