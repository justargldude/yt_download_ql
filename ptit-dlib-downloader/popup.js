/**
 * PTIT DLib Downloader — Popup logic
 *
 * - Queries content script for metadata on open
 * - Shows document info
 * - Sends download command → background → content script
 * - Sends cancel command directly to content script
 * - Reads progress from chrome.storage.session
 */
(function () {
  'use strict';

  // ── DOM refs ────────────────────────────────────────────────────
  const $noDoc = document.getElementById('no-doc');
  const $docInfo = document.getElementById('doc-info');
  const $progressSection = document.getElementById('progress-section');
  const $resultSection = document.getElementById('result-section');
  const $errorSection = document.getElementById('error-section');

  const $valDoc = document.getElementById('val-doc');
  const $valSub = document.getElementById('val-sub');
  const $valPages = document.getElementById('val-pages');

  const $btnDownload = document.getElementById('btn-download');
  const $btnRetry = document.getElementById('btn-retry');
  const $btnCancel = document.getElementById('btn-cancel');

  const $statusText = document.getElementById('status-text');
  const $progressFill = document.getElementById('progress-fill');
  const $progressText = document.getElementById('progress-text');
  const $resultText = document.getElementById('result-text');
  const $resultLink = document.getElementById('result-link');
  const $errorText = document.getElementById('error-text');
  const $logArea = document.getElementById('log-area');
  const $uploadEndpoint = document.getElementById('upload-endpoint');
  const $uploadApiKey = document.getElementById('upload-api-key');

  let currentTabId = null;
  let currentMetadata = null;
  const DEFAULT_UPLOAD_ENDPOINT = 'https://untagged-unleaded-bonelike.ngrok-free.dev/dlib/upload';

  const MAX_LOG = 100;
  const logLines = [];

  // ── Logging ──────────────────────────────────────────────────────
  function log(msg) {
    const ts = new Date().toLocaleTimeString('en-GB');
    logLines.push(`[${ts}] ${msg}`);
    if (logLines.length > MAX_LOG) logLines.shift();
    $logArea.textContent = logLines.join('\n');
    $logArea.scrollTop = $logArea.scrollHeight;
  }

  // ── UI helpers ───────────────────────────────────────────────────
  function hideAll() {
    [$noDoc, $docInfo, $progressSection, $resultSection, $errorSection].forEach(
      (el) => (el.style.display = 'none')
    );
  }

  function showOnly(section) {
    hideAll();
    if (section) section.style.display = 'block';
  }

  function showDocInfo(meta) {
    $valDoc.textContent = meta.doc
      ? meta.doc.substring(0, 20) + (meta.doc.length > 20 ? '…' : '')
      : '—';
    $valDoc.title = meta.doc || '';
    $valSub.textContent = meta.subfolder || '—';
    $valPages.textContent = meta.numPages || '?';
    showOnly($docInfo);
    $btnDownload.disabled = false;
    $btnDownload.textContent = 'Upload to Drive';
  }

  function showProgress(state) {
    $progressSection.style.display = 'block';
    $docInfo.style.display = 'block';
    $btnDownload.disabled = true;
    $btnDownload.textContent = 'Uploading...';
    $btnCancel.style.display = 'block';

    const statusMap = {
      fetching_metadata: 'Đang lấy thông tin…',
      downloading: 'Đang tải ảnh…',
      building_pdf: 'Đang tạo PDF… (đừng đóng tab)',
      uploading: 'Đang upload lên Drive…',
      paused_offline: '⏸ Mất mạng — đang chờ kết nối lại…',
    };
    $statusText.textContent = statusMap[state.status] || state.status;

    if (state.total > 0) {
      const pct = Math.round((state.current / state.total) * 100);
      $progressFill.style.width = pct + '%';
      $progressText.textContent =
        state.current +
        ' / ' +
        state.total +
        (state.failed > 0 ? '  (' + state.failed + ' lỗi)' : '');
    }
  }

  function showDone(state) {
    showOnly($resultSection);
    let msg;
    if (state.mode === 'drive' && state.link) {
      msg =
        state.failed > 0
          ? `✅ Đã tải lên Drive: ${state.filename || 'PDF'} — ${state.total} trang (${state.failed} trang lỗi)`
          : `✅ Đã tải lên Drive: ${state.filename || 'PDF'} — ${state.total} trang`;
    } else {
      msg =
        state.failed > 0
          ? `✅ Đã lưu về máy: ${state.filename || 'PDF'} — ${state.total} trang (${state.failed} trang lỗi)`
          : `✅ Đã lưu về máy: ${state.filename || 'PDF'} — ${state.total} trang`;
    }
    $resultText.textContent = msg;
    $resultText.className = 'msg-ok';
    if (state.link) {
      $resultLink.href = state.link;
      $resultLink.textContent = 'Mở link Drive';
      $resultLink.style.display = 'block';
    } else {
      $resultLink.style.display = 'none';
    }
    resetDownloadButton();
    log('Done: ' + msg);
  }

  function showCancelled(state) {
    showOnly($resultSection);
    $resultText.textContent =
      `⚠ Đã hủy — tải được ${state.current || 0}/${state.total || '?'} trang`;
    $resultText.className = 'msg-warn';
    $resultLink.style.display = 'none';
    resetDownloadButton();
    log('Cancelled');
  }

  function showError(errMsg) {
    showOnly($errorSection);
    $errorText.textContent = '❌ ' + errMsg;
    resetDownloadButton();
    log('Error: ' + errMsg);
  }

  function resetDownloadButton() {
    $btnDownload.disabled = false;
    $btnDownload.textContent = 'Upload to Drive';
    $btnCancel.style.display = 'none';
  }

  function getUploadSettings() {
    return {
      uploadEndpoint: ($uploadEndpoint.value || DEFAULT_UPLOAD_ENDPOINT).trim(),
      uploadApiKey: ($uploadApiKey.value || '').trim(),
    };
  }

  function saveUploadSettings() {
    const settings = getUploadSettings();
    chrome.storage.sync.set({
      dlibUploadEndpoint: settings.uploadEndpoint || DEFAULT_UPLOAD_ENDPOINT,
      dlibUploadApiKey: settings.uploadApiKey,
    });
  }

  async function loadUploadSettings() {
    const stored = await chrome.storage.sync.get({
      dlibUploadEndpoint: DEFAULT_UPLOAD_ENDPOINT,
      dlibUploadApiKey: '',
    });
    $uploadEndpoint.value = stored.dlibUploadEndpoint || DEFAULT_UPLOAD_ENDPOINT;
    $uploadApiKey.value = stored.dlibUploadApiKey || '';
  }

  // ── State sync via storage ───────────────────────────────────────
  function handleState(state) {
    if (!state) return;

    switch (state.status) {
      case 'idle':
        // Don't change UI — showDocInfo handles initial state
        break;
      case 'fetching_metadata':
      case 'downloading':
      case 'building_pdf':
      case 'uploading':
      case 'paused_offline':
        showProgress(state);
        break;
      case 'done':
        showDone(state);
        break;
      case 'cancelled':
        showCancelled(state);
        break;
      case 'error':
        showError(state.error || 'Unknown error');
        break;
    }
  }

  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.downloadState) {
      handleState(changes.downloadState.newValue);
    }
  });

  // ── Init: query active tab ───────────────────────────────────────
  async function init() {
    log('Popup opened');
    await loadUploadSettings();

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.url || !tab.url.includes('dlib.ptit.edu.vn')) {
      showOnly($noDoc);
      log('Not on dlib.ptit.edu.vn');
      return;
    }

    currentTabId = tab.id;
    log('Active tab: ' + tab.id);

    // Ask content script for metadata
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'GET_METADATA',
      });

      if (response && response.metadata && response.metadata.doc) {
        currentMetadata = response.metadata;
        showDocInfo(currentMetadata);
        log('Doc: ' + currentMetadata.doc.substring(0, 16) + '…');
        log('Subfolder: ' + currentMetadata.subfolder);
        log('Pages: ' + currentMetadata.numPages);

        // If content script says it's already downloading, reflect that
        if (response.downloading) {
          log('Download already in progress');
        }
      } else {
        showOnly($noDoc);
        log('Content script returned no metadata');
      }
    } catch (e) {
      showOnly($noDoc);
      log('Cannot reach content script: ' + e.message);
    }

    // Check if there's already a download in progress (from storage)
    const stored = await chrome.storage.session.get('downloadState');
    if (stored.downloadState && stored.downloadState.status !== 'idle') {
      handleState(stored.downloadState);
    }
  }

  // ── Download button ──────────────────────────────────────────────
  $btnDownload.addEventListener('click', () => {
    if (!currentMetadata || !currentTabId) return;
    if ($btnDownload.disabled) return;

    saveUploadSettings();
    const settings = getUploadSettings();
    const payload = {
      ...currentMetadata,
      uploadEndpoint: settings.uploadEndpoint,
      uploadApiKey: settings.uploadApiKey,
    };

    $btnDownload.disabled = true;
    $btnDownload.textContent = 'Starting...';
    log('Download requested');

    chrome.runtime.sendMessage({
      action: 'START_DOWNLOAD',
      tabId: currentTabId,
      metadata: payload,
    });
  });

  // ── Cancel button ────────────────────────────────────────────────
  $btnCancel.addEventListener('click', () => {
    if (!currentTabId) return;

    $btnCancel.disabled = true;
    $btnCancel.textContent = '⏳ Đang hủy…';
    log('Cancel requested');

    chrome.tabs.sendMessage(currentTabId, { action: 'CANCEL_DOWNLOAD' });
  });

  // ── Retry button ─────────────────────────────────────────────────
  $btnRetry.addEventListener('click', () => {
    if (currentMetadata) {
      showDocInfo(currentMetadata);
    }
  });

  // ── Go ───────────────────────────────────────────────────────────
  init();
})();
