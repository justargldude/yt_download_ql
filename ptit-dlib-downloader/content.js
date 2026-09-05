/**
 * PTIT DLib Downloader — Content Script
 *
 * Runs on dlib.ptit.edu.vn pages.
 * - Detects FlowPaper viewer pages
 * - Extracts document metadata (doc, subfolder, numPages)
 * - On command: fetches all page images, builds PDF via pdf-lib, triggers download
 *
 * Image fetching happens HERE (content script context) so that Referer,
 * cookies, and User-Agent match a real browser request exactly.
 * pdf-lib is injected on-demand by the service worker via chrome.scripting.
 */
(function () {
  'use strict';

  // ── Early bail ─────────────────────────────────────────────────────
  function isViewerPage() {
    return (
      document.getElementById('documentViewer') !== null ||
      /[?&]doc=/.test(location.search)
    );
  }

  if (!isViewerPage()) return;

  console.log('[DLib] Viewer page detected:', location.href);

  // ── Global abort controller ────────────────────────────────────────
  // Shared across all workers. Calling abortCtrl.abort() cancels
  // every in-flight fetch AND stops workers from picking new pages.
  let abortCtrl = null;

  // ── Network monitoring ─────────────────────────────────────────────
  // When the browser goes offline we pause; when it comes back we resume.
  // Workers await this promise; it resolves as soon as we're online.
  let networkResumeResolver = null;
  let networkPausePromise = null; // null ⇒ online, Promise ⇒ paused

  function pauseForOffline() {
    if (networkPausePromise) return; // already paused
    console.warn('[DLib] Network OFFLINE — pausing downloads');
    networkPausePromise = new Promise((resolve) => {
      networkResumeResolver = resolve;
    });
    updateState({
      status: 'paused_offline',
      current: _progressCurrent,
      total: _progressTotal,
      failed: _progressFailed,
      error: null,
    });
  }

  function resumeFromOnline() {
    if (!networkPausePromise) return;
    console.log('[DLib] Network ONLINE — resuming');
    networkResumeResolver();
    networkPausePromise = null;
    networkResumeResolver = null;
    updateState({
      status: 'downloading',
      current: _progressCurrent,
      total: _progressTotal,
      failed: _progressFailed,
      error: null,
    });
  }

  /** Wait until network is available. Returns immediately if online. */
  async function waitForNetwork() {
    if (networkPausePromise) await networkPausePromise;
  }

  window.addEventListener('offline', pauseForOffline);
  window.addEventListener('online', resumeFromOnline);

  // Track progress for pause/resume state updates
  let _progressCurrent = 0;
  let _progressTotal = 0;
  let _progressFailed = 0;
  // NO hardcoded endpoint/api-key here anymore (security): values come
  // from chrome.storage.sync via the popup UI. Empty → upload disabled,
  // local PDF save only.

  // ── beforeunload guard ─────────────────────────────────────────────
  function onBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';       // required by Chrome
    return '';                // required by some browsers
  }

  // ── Metadata extraction ────────────────────────────────────────────

  function extractMetadata() {
    const url = new URL(location.href);
    const params = url.searchParams;

    // 1. doc — most reliable: URL query param
    let doc = params.get('doc');
    if (doc) doc = decodeURIComponent(doc);

    // 2. subfolder — URL query param
    let subfolder = params.get('subfolder');
    if (subfolder) subfolder = decodeURIComponent(subfolder);

    // 3. numPages — parse from inline <script> in page
    let numPages = null;

    // 4. serviceUrl base — parse getDocumentUrl() template
    let serviceUrlTemplate = null;

    // 5. bitsid / uid — may be needed in the future
    let bitsid = params.get('bitsid');
    let uid = params.get('uid');

    // Parse inline scripts for additional data
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
      const text = script.textContent || '';

      // numPages: var numPages = 138;  (may have tabs/spaces)
      if (numPages === null) {
        const m = text.match(/var\s+numPages\s*=\s*(\d+)/);
        if (m) numPages = parseInt(m[1], 10);
      }

      // Fallback: startDocument from HTML if URL didn't have doc=
      if (!doc) {
        const m = text.match(/var\s+startDocument\s*=\s*"([^"]+)"/);
        if (m) doc = m[1];
      }

      // Fallback: subfolder from getDocumentUrl body
      if (!subfolder) {
        const m = text.match(/subfolder[=:]([^&"'\s]+)/);
        if (m) subfolder = decodeURIComponent(m[1]);
      }

      // Extract service URL template (e.g. "services/view.php?doc={doc}&format=...")
      if (!serviceUrlTemplate) {
        const m = text.match(
          /return\s+"([^"]*(?:services\/view\.php|view\.php)[^"]*)"/
        );
        if (m) serviceUrlTemplate = m[1];
      }
    }

    return { doc, subfolder, numPages, serviceUrlTemplate, bitsid, uid };
  }

  const metadata = extractMetadata();
  console.log('[DLib] Extracted metadata:', metadata);

  if (!metadata.doc) {
    console.warn('[DLib] Could not find document ID. Aborting.');
    return;
  }

  // Notify background
  chrome.runtime.sendMessage({
    action: 'METADATA_DETECTED',
    metadata,
  });

  // ── URL helpers ────────────────────────────────────────────────────

  function getBaseUrl() {
    const pathDir = location.pathname.substring(
      0,
      location.pathname.lastIndexOf('/') + 1
    );
    return location.origin + pathDir;
  }

  // ── JSONP metadata fetch (confirm numPages) ────────────────────────

  async function fetchJsonpMetadata(doc, subfolder) {
    const base = getBaseUrl();
    const url =
      base +
      'services/view.php?doc=' +
      encodeURIComponent(doc) +
      '&format=jsonp&page=1&subfolder=' +
      encodeURIComponent(subfolder) +
      '&_t=' +
      Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      let text = await res.text();

      // Strip JSONP wrapper: callbackName([...])  →  [...]
      const jsonpMatch = text.match(/^[^(]*\(([\s\S]+)\)\s*;?\s*$/);
      if (jsonpMatch) text = jsonpMatch[1];

      const data = JSON.parse(text);
      const page = Array.isArray(data) ? data[0] : data;
      return {
        numPages: page.pages || page.numPages,
        width: page.width,
        height: page.height,
      };
    } catch (e) {
      console.warn('[DLib] JSONP fetch failed:', e.message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Image downloading ──────────────────────────────────────────────

  function buildImageUrl(doc, subfolder, page) {
    const base = getBaseUrl();
    return (
      base +
      'services/view.php?doc=' +
      encodeURIComponent(doc) +
      '&format=jpg&page=' +
      page +
      '&subfolder=' +
      encodeURIComponent(subfolder)
    );
  }

  /**
   * Download a single page image with retries + validation.
   * Respects the shared AbortController and waits if offline.
   */
  async function fetchPageImage(doc, subfolder, pageNum) {
    const MAX_RETRIES = 3;
    const url = buildImageUrl(doc, subfolder, pageNum);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // ── Check cancellation
      if (abortCtrl && abortCtrl.signal.aborted) {
        throw new Error('Cancelled');
      }

      // ── Wait if offline
      await waitForNetwork();

      try {
        const res = await fetch(url, {
          signal: abortCtrl ? abortCtrl.signal : undefined,
        });

        // Detect redirect → session expired
        if (res.redirected) {
          throw new Error('Redirected — session may have expired');
        }

        // Content-Type validation
        const ct = (res.headers.get('Content-Type') || '').toLowerCase();
        if (!ct.startsWith('image/')) {
          throw new Error('Unexpected Content-Type: ' + ct);
        }

        const buffer = await res.arrayBuffer();
        if (buffer.byteLength < 100) {
          throw new Error('Response too small (' + buffer.byteLength + ' B)');
        }

        // Magic bytes
        const hdr = new Uint8Array(buffer, 0, 8);
        const isPng =
          hdr[0] === 0x89 &&
          hdr[1] === 0x50 &&
          hdr[2] === 0x4e &&
          hdr[3] === 0x47;
        const isJpeg =
          hdr[0] === 0xff && hdr[1] === 0xd8 && hdr[2] === 0xff;

        if (!isPng && !isJpeg) {
          throw new Error(
            'Unknown image format (header: ' +
              Array.from(hdr.subarray(0, 4))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' ') +
              ')'
          );
        }

        return { buffer, isPng, isJpeg };
      } catch (e) {
        // If abort → don't retry
        if (e.name === 'AbortError' || e.message === 'Cancelled') {
          throw new Error('Cancelled');
        }

        // If offline → wait then retry (don't count as attempt)
        if (!navigator.onLine) {
          pauseForOffline();
          await waitForNetwork();
          attempt--; // don't count this as a failed attempt
          continue;
        }

        if (attempt < MAX_RETRIES - 1) {
          const delay =
            Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(
            `[DLib] Page ${pageNum} attempt ${attempt + 1} failed: ${e.message}. Retry in ${Math.round(delay)}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Download all images concurrently with a worker pool.
   * Supports cancellation via shared abortCtrl and auto-pause on offline.
   */
  async function downloadAllImages(doc, subfolder, numPages, onProgress) {
    const MAX_CONCURRENT = 6;
    const images = new Array(numPages); // ordered
    const failed = [];
    let completed = 0;
    let cancelled = false;

    const queue = [];
    for (let i = 1; i <= numPages; i++) queue.push(i);

    async function worker() {
      while (queue.length > 0) {
        // Check cancellation
        if (abortCtrl && abortCtrl.signal.aborted) {
          cancelled = true;
          return;
        }

        const pageNum = queue.shift();
        try {
          images[pageNum - 1] = await fetchPageImage(doc, subfolder, pageNum);
        } catch (e) {
          if (e.message === 'Cancelled') {
            cancelled = true;
            return;
          }
          console.error(
            `[DLib] Page ${pageNum} FAILED after retries:`,
            e.message
          );
          images[pageNum - 1] = null;
          failed.push(pageNum);
        }
        completed++;
        _progressCurrent = completed;
        _progressFailed = failed.length;
        onProgress(completed, numPages, failed.length);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT, numPages); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return { images, failed, cancelled };
  }

  // ── PDF construction ───────────────────────────────────────────────

  async function buildPdf(images, numPages, docId) {
    /* global PDFLib */
    const pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setCreator('PTIT DLib Downloader');
    pdfDoc.setProducer('pdf-lib');
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setTitle('dlib_' + (docId || 'unknown'));

    // A4 dimensions in PDF points (1 point = 1/72 inch)
    const A4_WIDTH = 595.28;
    const A4_HEIGHT = 841.89;

    for (let i = 0; i < numPages; i++) {
      const img = images[i];
      if (!img) {
        pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
        continue;
      }

      try {
        let embedded;
        const bytes = new Uint8Array(img.buffer);
        if (img.isPng) {
          embedded = await pdfDoc.embedPng(bytes);
        } else {
          embedded = await pdfDoc.embedJpg(bytes);
        }

        // Dynamically size pages to match image aspect ratio.
        // Standard width is A4_WIDTH (595.28) for portrait/square, and A4_HEIGHT (841.89) for landscape.
        // This ensures a landscape image uses landscape page dimensions, and portrait uses portrait.
        const imgAspect = embedded.height / embedded.width;
        let pageWidth, pageHeight;

        if (imgAspect >= 1) {
          // Portrait / Square
          pageWidth = A4_WIDTH;
          pageHeight = A4_WIDTH * imgAspect;
        } else {
          // Landscape
          pageWidth = A4_HEIGHT;
          pageHeight = A4_HEIGHT * imgAspect;
        }

        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        page.drawImage(embedded, {
          x: 0,
          y: 0,
          width: pageWidth,
          height: pageHeight,
        });
      } catch (e) {
        console.error(`[DLib] Failed to embed page ${i + 1}:`, e.message);
        pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
      }

      // Release buffer to reduce memory pressure
      images[i] = null;
    }

    return await pdfDoc.save();
  }

  // ── Download trigger ───────────────────────────────────────────────

  async function uploadPdfToDrive(pdfBytes, filename, meta) {
    const endpoint = (meta.uploadEndpoint || '').trim();
    const apiKey = (meta.uploadApiKey || '').trim();

    if (!endpoint) {
      throw new Error('Upload endpoint is not configured — set it in the extension popup (e.g. http://127.0.0.1:8765/dlib/upload)');
    }

    const uploadCtrl = new AbortController();
    const timeout = setTimeout(() => uploadCtrl.abort(), 15 * 60 * 1000);
    const abortUpload = () => uploadCtrl.abort();
    if (abortCtrl) {
      if (abortCtrl.signal.aborted) throw new Error('Cancelled');
      abortCtrl.signal.addEventListener('abort', abortUpload, { once: true });
    }

    try {
      const headers = {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent(filename),
        'X-Doc-Id': encodeURIComponent(meta.doc || metadata.doc || ''),
        'ngrok-skip-browser-warning': 'true',
      };
      if (apiKey) headers['X-Api-Key'] = apiKey;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: new Blob([pdfBytes], { type: 'application/pdf' }),
        signal: uploadCtrl.signal,
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        // Non-JSON response; handled by the error path below.
      }

      if (!res.ok || !data || data.ok === false) {
        throw new Error(
          (data && data.error) || `Upload failed with HTTP ${res.status}`
        );
      }

      const link = data.link || data.webViewLink;
      if (!link) throw new Error('Upload succeeded but no link was returned');

      return {
        link,
        fileId: data.fileId || null,
        fileName: data.fileName || filename,
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Cancelled');
      throw e;
    } finally {
      clearTimeout(timeout);
      if (abortCtrl) {
        abortCtrl.signal.removeEventListener('abort', abortUpload);
      }
    }
  }

  // ── Upload server health check ────────────────────────────────────

  async function checkUploadServer(meta) {
    const endpoint = (meta.uploadEndpoint || '').trim();
    if (!endpoint) return false;

    // Check if localhost (owner's agent) is active to verify if this is the owner's machine.
    // If not, we assume guest mode and skip the Drive upload, saving locally instead.
    let isOwner = false;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8765/dlib/health', {
        signal: ctrl.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        isOwner = (data.ok === true);
      }
    } catch (_) {
      isOwner = false;
    }

    if (!isOwner) {
      console.log('[DLib] Local agent not running on port 8765. Guest mode: skipping Drive upload.');
      return false;
    }

    // Derive health URL from upload URL: /dlib/upload → /dlib/health
    const healthUrl = endpoint.replace(/\/upload\/?$/, '/health');

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(healthUrl, {
        signal: ctrl.signal,
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      clearTimeout(timeout);
      if (!res.ok) return false;
      const data = await res.json();
      return data.ok === true;
    } catch (e) {
      console.log('[DLib] Upload server not reachable:', e.message);
      return false;
    }
  }

  // ── Local download trigger ────────────────────────────────────────

  function triggerBrowserDownload(pdfBytes, filename) {
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ── Progress reporting ─────────────────────────────────────────────

  function updateState(state) {
    try {
      chrome.storage.session.set({ downloadState: state });
    } catch (_) {
      // popup may be closed, storage may be unavailable — ignore
    }
  }

  // ── Main download orchestrator ─────────────────────────────────────

  let downloading = false;

  async function startDownload(meta) {
    if (downloading) {
      console.warn('[DLib] Download already in progress');
      return;
    }
    downloading = true;

    // ── Set up abort controller
    abortCtrl = new AbortController();

    // ── Warn user about leaving the page
    window.addEventListener('beforeunload', onBeforeUnload);

    // ── Check network before starting
    if (!navigator.onLine) {
      updateState({
        status: 'paused_offline',
        current: 0,
        total: 0,
        failed: 0,
        error: null,
      });
      // Wait until network is back
      pauseForOffline();
      await waitForNetwork();
    }

    const doc = meta.doc || metadata.doc;
    const subfolder = meta.subfolder || metadata.subfolder;
    let numPages = meta.numPages || metadata.numPages;

    _progressCurrent = 0;
    _progressTotal = 0;
    _progressFailed = 0;

    updateState({
      status: 'fetching_metadata',
      current: 0,
      total: 0,
      failed: 0,
      error: null,
    });

    // ── Step 1: Confirm numPages via JSONP
    console.log('[DLib] Fetching JSONP metadata…');
    const jsonp = await fetchJsonpMetadata(doc, subfolder);
    if (jsonp && jsonp.numPages) {
      console.log(
        '[DLib] JSONP confirms',
        jsonp.numPages,
        'pages (HTML said',
        numPages + ')'
      );
      numPages = jsonp.numPages; // JSONP is source of truth
    }

    if (!numPages || numPages < 1) {
      cleanup();
      updateState({
        status: 'error',
        error: 'Could not determine page count',
      });
      return;
    }

    _progressTotal = numPages;

    // ── Step 2: Download images
    console.log(`[DLib] Downloading ${numPages} pages…`);
    updateState({
      status: 'downloading',
      current: 0,
      total: numPages,
      failed: 0,
      error: null,
    });

    const { images, failed, cancelled } = await downloadAllImages(
      doc,
      subfolder,
      numPages,
      (current, total, failedCount) => {
        updateState({
          status: 'downloading',
          current,
          total,
          failed: failedCount,
          error: null,
        });
      }
    );

    // ── Cancelled?
    if (cancelled) {
      cleanup();
      updateState({
        status: 'cancelled',
        current: _progressCurrent,
        total: numPages,
        failed: failed.length,
        error: null,
      });
      console.log('[DLib] Download cancelled by user');
      return;
    }

    // ── Too many failures? Abort instead of producing mostly-blank PDF
    if (failed.length > numPages * 0.5) {
      cleanup();
      updateState({
        status: 'error',
        current: _progressCurrent,
        total: numPages,
        failed: failed.length,
        error: `Quá nhiều trang lỗi (${failed.length}/${numPages}). Kiểm tra mạng rồi thử lại.`,
      });
      return;
    }

    // ── Step 3: Build PDF
    console.log('[DLib] Building PDF…');
    updateState({
      status: 'building_pdf',
      current: numPages,
      total: numPages,
      failed: failed.length,
      error: null,
    });

    let pdfBytes;
    try {
      pdfBytes = await buildPdf(images, numPages, doc);
    } catch (e) {
      console.error('[DLib] PDF build failed:', e);
      cleanup();
      updateState({
        status: 'error',
        error: 'PDF build failed: ' + e.message,
      });
      return;
    }

    // ── Step 4: Check server → Upload to Drive or save locally
    const filename =
      'dlib_' + (doc || 'document').substring(0, 12) + '.pdf';

    console.log('[DLib] Checking upload server…');
    const serverAvailable = await checkUploadServer(meta);

    if (serverAvailable) {
      // ── Path A: Upload to Google Drive
      console.log(
        `[DLib] Uploading ${filename} (${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB)`
      );
      updateState({
        status: 'uploading',
        current: numPages,
        total: numPages,
        failed: failed.length,
        error: null,
        filename,
      });

      let uploadResult;
      try {
        uploadResult = await uploadPdfToDrive(pdfBytes, filename, meta);
      } catch (e) {
        if (e.message === 'Cancelled') {
          cleanup();
          updateState({
            status: 'cancelled',
            current: _progressCurrent,
            total: numPages,
            failed: failed.length,
            error: null,
          });
          console.log('[DLib] Upload cancelled');
          return;
        }
        // Upload failed → fall back to local download
        console.warn('[DLib] Upload failed, saving locally:', e.message);
        triggerBrowserDownload(pdfBytes, filename);
        cleanup();
        updateState({
          status: 'done',
          current: numPages,
          total: numPages,
          failed: failed.length,
          error: null,
          filename,
          mode: 'local',
          link: null,
        });
        try {
          chrome.runtime.sendMessage({
            action: 'DOWNLOAD_COMPLETE',
            filename,
            totalPages: numPages,
            failedPages: failed.length,
          });
        } catch (_) {}
        console.log('[DLib] Done (local fallback after upload failure)');
        return;
      }

      // Upload succeeded
      const finalState = {
        status: 'done',
        current: numPages,
        total: numPages,
        failed: failed.length,
        error: null,
        filename: uploadResult.fileName || filename,
        fileId: uploadResult.fileId,
        link: uploadResult.link,
        mode: 'drive',
      };
      updateState(finalState);

      try {
        chrome.runtime.sendMessage({
          action: 'UPLOAD_COMPLETE',
          filename: finalState.filename,
          link: finalState.link,
          totalPages: numPages,
          failedPages: failed.length,
        });
      } catch (_) {}
    } else {
      // ── Path B: Server unavailable → local download
      console.log(
        `[DLib] Server offline. Saving locally: ${filename} (${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB)`
      );
      triggerBrowserDownload(pdfBytes, filename);
      updateState({
        status: 'done',
        current: numPages,
        total: numPages,
        failed: failed.length,
        error: null,
        filename,
        mode: 'local',
        link: null,
      });

      try {
        chrome.runtime.sendMessage({
          action: 'DOWNLOAD_COMPLETE',
          filename,
          totalPages: numPages,
          failedPages: failed.length,
        });
      } catch (_) {}
    }

    cleanup();
    console.log(
      '[DLib] Done!',
      failed.length ? 'Failed pages: ' + failed.join(', ') : ''
    );
  }

  /** Remove beforeunload guard + reset state */
  function cleanup() {
    downloading = false;
    abortCtrl = null;
    networkPausePromise = null;
    networkResumeResolver = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
  }

  /** Cancel an in-flight download */
  function cancelDownload() {
    if (abortCtrl) {
      abortCtrl.abort();
      console.log('[DLib] Abort signal sent');
    }
  }

  // ── Message listener ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'GET_METADATA') {
      sendResponse({ metadata, downloading });
      return false;
    }

    if (msg.action === 'START_DOWNLOAD') {
      startDownload(msg.metadata || metadata);
      sendResponse({ status: 'started' });
      return false;
    }

    if (msg.action === 'CANCEL_DOWNLOAD') {
      cancelDownload();
      sendResponse({ status: 'cancelling' });
      return false;
    }

    if (msg.action === 'PING') {
      sendResponse({ pong: true, downloading });
      return false;
    }
  });

  // Reset state on page load (clears stale "downloading" from a previous F5)
  updateState({
    status: 'idle',
    current: 0,
    total: 0,
    failed: 0,
    error: null,
  });
})();
