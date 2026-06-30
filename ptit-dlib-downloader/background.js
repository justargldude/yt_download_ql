/**
 * PTIT DLib Downloader — Service Worker (background.js)
 *
 * Lightweight coordinator:
 * - Stores metadata from content script
 * - Injects pdf-lib on demand before download starts
 * - Relays start command to content script
 * - Shows system notification on completion
 */

// ── Metadata storage ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'METADATA_DETECTED') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const data = {
      ...msg.metadata,
      tabId,
      tabUrl: sender.tab.url,
      detectedAt: Date.now(),
    };

    chrome.storage.session.set({ ['meta_' + tabId]: data });
    console.log('[DLib SW] Metadata stored for tab', tabId, data);
    return;
  }

  if (msg.action === 'START_DOWNLOAD') {
    handleStartDownload(msg.tabId, msg.metadata);
    sendResponse({ status: 'ok' });
    return;
  }

  if (msg.action === 'DOWNLOAD_COMPLETE') {
    showNotification(msg.filename, msg.totalPages, msg.failedPages);
    return;
  }

  if (msg.action === 'UPLOAD_COMPLETE') {
    showNotification(msg.filename, msg.totalPages, msg.failedPages, msg.link);
    return;
  }
});

// ── Download orchestration ─────────────────────────────────────────

async function handleStartDownload(tabId, metadata) {
  try {
    // Step 1: Inject pdf-lib into the content script's isolated world
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/pdf-lib.min.js'],
      world: 'ISOLATED',
    });
    console.log('[DLib SW] pdf-lib injected into tab', tabId);

    // Step 2: Small delay to ensure pdf-lib globals are ready
    await new Promise((r) => setTimeout(r, 100));

    // Step 3: Tell content script to start downloading
    chrome.tabs.sendMessage(tabId, {
      action: 'START_DOWNLOAD',
      metadata,
    });
  } catch (e) {
    console.error('[DLib SW] Failed to start download:', e);
    chrome.storage.session.set({
      downloadState: {
        status: 'error',
        error: 'Failed to inject pdf-lib: ' + e.message,
      },
    });
  }
}

// ── Notifications ─────────────────────────────────────────────────

function showNotification(filename, totalPages, failedPages, driveLink) {
  let message;
  if (driveLink) {
    message =
      failedPages > 0
        ? `Uploaded ${filename} to Drive (${totalPages} pages, ${failedPages} failed)`
        : `Uploaded ${filename} to Drive (${totalPages} pages)`;
  } else {
    message =
      failedPages > 0
        ? `Saved ${filename} (${totalPages} pages, ${failedPages} failed)`
        : `Saved ${filename} (${totalPages} pages)`;
  }

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="%23333" rx="16"/><text x="64" y="78" text-anchor="middle" fill="white" font-size="48" font-family="sans-serif">PDF</text></svg>'),
    title: 'PTIT DLib Downloader',
    message,
  });
}

// ── Cleanup on tab close ──────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('meta_' + tabId);
});
