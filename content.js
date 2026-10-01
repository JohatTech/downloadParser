/**
 * Content Script for YouTube Playlist MP3 Converter.
 * Strictly operates in read-only extraction mode.
 * DOES NOT inject any UI elements or modify the YouTube webpage.
 * All user interfaces reside exclusively within the Chrome Extension Panel.
 */

(() => {
  // Listen for extraction requests from the extension panel
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "EXTRACT_PLAYLIST") {
      try {
        const result = extractPlaylistData();
        sendResponse({ success: true, data: result });
      } catch (err) {
        console.error("Extraction error:", err);
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (request.action === "CHECK_PLAYLIST_STATUS") {
      const isPlaylistPage = window.location.pathname.includes("/playlist") ||
                             window.location.search.includes("list=");
      sendResponse({
        isPlaylistPage,
        url: window.location.href,
        title: document.title
      });
      return true;
    }

    if (request.action === "SCROLL_FOR_MORE") {
      window.scrollTo(0, document.documentElement.scrollHeight);
      setTimeout(() => {
        try {
          const result = extractPlaylistData();
          sendResponse({ success: true, data: result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      }, 1000);
      return true;
    }
  });

  /**
   * Extracts playlist details and video items from the current YouTube page.
   * Handles both standalone playlist pages (/playlist?list=...)
   * and watch pages with an active playlist drawer (/watch?v=...&list=...).
   */
  function extractPlaylistData() {
    const pageUrl = window.location.href;
    const urlObj = new URL(pageUrl);
    const playlistId = urlObj.searchParams.get("list");

    // Extract Playlist Title
    let playlistTitle = "YouTube Playlist";
    const headerTitleEl = document.querySelector(
      "ytd-playlist-header-renderer yt-dynamic-sizing-formatted-string, " +
      "ytd-playlist-header-renderer #text, " +
      "#playlist-header #title, " +
      ".metadata-wrapper #title"
    );
    if (headerTitleEl && headerTitleEl.innerText.trim()) {
      playlistTitle = headerTitleEl.innerText.trim();
    } else {
      playlistTitle = document.title.replace(" - YouTube", "").trim();
    }

    const videos = [];
    const seenIds = new Set();

    // 1. Try extracting from standard playlist video items
    const playlistRenderers = document.querySelectorAll("ytd-playlist-video-renderer");
    if (playlistRenderers.length > 0) {
      playlistRenderers.forEach((el, index) => {
        const titleEl = el.querySelector("#video-title, a#video-title");
        if (!titleEl) return;

        const title = titleEl.innerText.trim() || titleEl.getAttribute("title") || `Video ${index + 1}`;
        const href = titleEl.getAttribute("href") || "";
        const idMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        const videoId = idMatch ? idMatch[1] : null;

        if (!videoId || seenIds.has(videoId)) return;
        seenIds.add(videoId);

        // Thumbnail
        const imgEl = el.querySelector("ytd-thumbnail img, #img");
        let thumbnail = imgEl ? (imgEl.src || imgEl.getAttribute("src")) : "";
        if (!thumbnail || thumbnail.startsWith("data:")) {
          thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
        }

        // Duration
        const durationEl = el.querySelector(
          "ytd-thumbnail-overlay-time-status-renderer span#text, " +
          "ytd-thumbnail-overlay-time-status-renderer, " +
          "#time-status span"
        );
        const duration = durationEl ? durationEl.innerText.trim() : "Unknown";

        // Channel Name
        const channelEl = el.querySelector("ytd-channel-name a, #byline a, #channel-name");
        const channel = channelEl ? channelEl.innerText.trim() : "Unknown Artist";

        videos.push({
          index: videos.length + 1,
          id: videoId,
          title: cleanVideoTitle(title),
          rawTitle: title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: thumbnail,
          duration: duration,
          channel: channel,
          status: "pending_permission", // "pending_permission" | "converting" | "converted" | "error"
          downloadUrl: null,
          error: null
        });
      });
    }

    // 2. Try extracting from Watch page playlist panel drawer (if on a video with playlist)
    if (videos.length === 0) {
      const panelRenderers = document.querySelectorAll("ytd-playlist-panel-video-renderer");
      panelRenderers.forEach((el, index) => {
        const titleEl = el.querySelector("#video-title");
        if (!titleEl) return;

        const title = titleEl.innerText.trim() || `Video ${index + 1}`;
        const linkEl = el.querySelector("a#wc-endpoint") || titleEl.closest("a");
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const idMatch = href ? href.match(/[?&]v=([a-zA-Z0-9_-]{11})/) : null;
        const videoId = idMatch ? idMatch[1] : null;

        if (!videoId || seenIds.has(videoId)) return;
        seenIds.add(videoId);

        const imgEl = el.querySelector("img#img, img");
        let thumbnail = imgEl ? imgEl.src : "";
        if (!thumbnail || thumbnail.startsWith("data:")) {
          thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
        }

        const channelEl = el.querySelector("#byline");
        const channel = channelEl ? channelEl.innerText.trim() : "Unknown Artist";

        const durationEl = el.querySelector(
          "ytd-thumbnail-overlay-time-status-renderer span#text, #time-status"
        );
        const duration = durationEl ? durationEl.innerText.trim() : "Unknown";

        videos.push({
          index: videos.length + 1,
          id: videoId,
          title: cleanVideoTitle(title),
          rawTitle: title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: thumbnail,
          duration: duration,
          channel: channel,
          status: "pending_permission",
          downloadUrl: null,
          error: null
        });
      });
    }

    return {
      playlistId: playlistId || "unknown",
      playlistTitle: playlistTitle,
      totalCount: videos.length,
      pageUrl: pageUrl,
      videos: videos
    };
  }

  /**
   * Cleans YouTube video titles for safe file naming and pleasant display.
   */
  function cleanVideoTitle(raw) {
    if (!raw) return "YouTube Video";
    return raw
      .replace(/[\/\?<>\\:\*\|"]/g, "") // Remove Windows invalid filename characters
      .replace(/\s+/g, " ")
      .trim();
  }
})();
