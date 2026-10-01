# Architecture & Technical Design

## 1. System Overview
The **YouTube Playlist MP3 Converter** is a Google Chrome Extension (Manifest V3) paired with an optional high-performance Node.js companion server running the **`youtube-mp3-downloader`** npm library.

The extension strictly isolates all user interfaces, permission prompts, conversions, and download actions inside the **Chrome Extension Panel** (`side_panel` & `action` popup). Zero UI elements or overlays are injected into the YouTube tab DOM.

---

## 2. Processing & Data Flow Diagram

```mermaid
flowchart TD
    A[User opens YouTube Playlist Tab] --> B[User clicks Extension Panel Icon]
    B --> C[Extension Panel opens in Chrome Side Panel / Popup]
    C --> D[Panel auto-detects Playlist or User clicks 'Extract from Active Tab']
    D --> E[content.js scans DOM & ytInitialData]
    E --> F[Extracts Video Titles, IDs, URLs, Durations, Thumbnails]
    F --> G[Renders Video Cards in Extension Panel Queue]
    G --> H{User selects item to convert}
    H --> I[Extension Panel opens Permission Confirmation Modal]
    I --> J{User grants permission for this item?}
    J -->|No / Skip| K[Item remains skipped; queue continues]
    J -->|Yes / Authorize| L[Audio Conversion Engine engaged]
    L --> M{Selected Engine}
    M -->|Local npm Server| N[POST /api/convert to youtube-mp3-downloader backend]
    M -->|Web Direct Engine| O[Client-side audio extraction & MP3 stream transcode]
    N --> P[Conversion completes with 192kbps MP3]
    O --> P
    P --> Q[Panel updates Video Card to 'Converted' state]
    Q --> R[Display 'Download MP3' button & Audio Preview Player]
    R --> S[User clicks Download MP3]
    S --> T[chrome.downloads saves sanitized MP3 file locally]
```

---

## 3. Class & Component Diagram

```mermaid
classDiagram
    class ExtensionPanelController {
        -Object state
        -DOMElement elements
        +loadSettings() void
        +saveSettings() void
        +checkCompanionServer() Promise~void~
        +extractFromActiveTab() Promise~void~
        +populatePlaylist(data) void
        +promptPermissionModal(video) Promise~boolean~
        +startSequentialPermissionFlow() Promise~void~
        +executeConversion(video) Promise~void~
        +triggerDownload(video) void
        +toggleAudioPreview(video, btn) void
    }

    class ContentScriptExtractor {
        +extractPlaylistData() Object
        +cleanVideoTitle(rawTitle) String
        +handleScrollForMore() void
    }

    class BackgroundWorker {
        +onInstalled(details) void
        +onMessage(request, sender, sendResponse) boolean
        +handleDownload(url, filename) Promise~void~
    }

    class LocalConverterServer {
        -Map activeJobs
        -YoutubeMp3Downloader YD
        -String downloadDir
        +postConvert(req, res) void
        +getStatus(req, res) void
        +getDownload(req, res) void
        +getFiles(req, res) void
    }

    class PlaylistItem {
        +String id
        +String title
        +String url
        +String thumbnail
        +String duration
        +String channel
        +String status
        +Number progress
        +String downloadUrl
    }

    ExtensionPanelController --> ContentScriptExtractor : messages via chrome.tabs
    ExtensionPanelController --> BackgroundWorker : messages via chrome.runtime
    ExtensionPanelController --> LocalConverterServer : HTTP fetch REST API
    ExtensionPanelController *-- PlaylistItem : manages queue of
```

---

## 4. Key Architectural Patterns & Guarantees

### A. Non-Intrusive Ingestion
- `content.js` acts solely as a read-only extractor.
- Extracts `videoId`, `title`, `url`, `duration`, `thumbnail`, and `channel` from:
  1. `ytd-playlist-video-renderer` on `/playlist?list=...`
  2. `ytd-playlist-panel-video-renderer` on `/watch?v=...&list=...`
- It does **not** attach buttons or manipulate styles on YouTube.

### B. Explicit Per-Item Permission Verification
- In accordance with strict user consent requirements, items are never converted automatically.
- Each item is initialized in state `pending_permission`.
- The user can authorize items individually via the **Grant Permission & Convert** card button, or execute the **Step-by-Step Convert** queue.
- In Step-by-Step mode, an interactive permission modal is presented before each individual video starts processing.

### C. Conversion Engine
1. **Local npm Server Engine (`youtube-mp3-downloader`)**:
   - An Express service operating on `http://localhost:4567`.
   - Utilizes `youtube-mp3-downloader`, `@distube/ytdl-core`, and `ffmpeg-static`.
   - Produces clean MP3 files with ID3 metadata and 192/320 kbps audio quality.
2. **Web Direct Standalone Engine**:
   - Built into `sidepanel.js` to ensure the extension functions immediately inside Chrome even when the local server is not running.

### D. Download Delivery
- Once conversion reaches 100%, the card transitions to state `converted`.
- A prominent `Download MP3` button is rendered.
- Files are saved directly to the user's default Downloads directory via `chrome.downloads` with sanitized filenames.
- An inline audio preview player (`▶ Preview`) is available directly on the card to verify audio quality before downloading.
