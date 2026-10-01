# YouTube MP3 Converter Local Companion Server

This server executes audio extraction and MP3 transcoding using the **`youtube-mp3-downloader`** npm library.

## Quick Start

### 1. Install Dependencies
```bash
cd server
npm install
```

### 2. Start the Server
```bash
npm start
```
The server will boot on `http://localhost:4567`.

### 3. Verify Health
Visit: [http://localhost:4567/health](http://localhost:4567/health)
Expected JSON response:
```json
{
  "status": "ok",
  "service": "YouTube MP3 Downloader Server",
  "library": "youtube-mp3-downloader",
  "ffmpegAvailable": true
}
```

## How It Works with the Chrome Extension
1. When the Chrome Extension Panel opens, it pings `http://localhost:4567/health`.
2. If the server is running, the extension shows a **🟢 Connected to Local npm Engine** badge.
3. When you grant permission to convert a video, the extension instructs this server to download and transcode the video to MP3 at highest audio quality.
4. When finished, a download button appears directly in the Chrome Extension Panel.
