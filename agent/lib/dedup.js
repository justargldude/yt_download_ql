// lib/dedup.js — URL deduplication coordinator.
// Fixes the "duplicate URL → instant error" UX bug: when request B arrives
// for a video that request A is currently processing, B used to be marked
// status='error' even though processor.js's downloadLocks + source cache
// would have handled B gracefully (wait → reuse cached file). Instead of
// failing the user, B is DEFERRED and retried on the next poll cycle.
/**
 * @param {{ processingUrls: Map<string, string> }} opts
 *   processingUrls: the live map of normalizedUrl → requestId currently
 *   being processed. The coordinator reads it (no ownership) so its
 *   isProcessing() view always matches the agent loop's state.
 */
export function createDedupCoordinator({ processingUrls }) {
  // normalizedUrl → FIFO queue of deferred requestIds
  const deferredQueues = new Map();

  function isProcessing(normalizedUrl) {
    return processingUrls.has(normalizedUrl);
  }

  /** Queue requestId behind a busy URL. Returns true if deferred. */
  function defer(requestId, normalizedUrl) {
    if (!requestId || !normalizedUrl) return false;
    let q = deferredQueues.get(normalizedUrl);
    if (!q) {
      q = [];
      deferredQueues.set(normalizedUrl, q);
    }
    if (!q.includes(requestId)) q.push(requestId);
    return true;
  }

  function hasDeferred(normalizedUrl) {
    const q = deferredQueues.get(normalizedUrl);
    return Boolean(q && q.length > 0);
  }

  /** Pop the next deferred requestId for this URL (FIFO), or null. */
  function takeDeferred(normalizedUrl) {
    const q = deferredQueues.get(normalizedUrl);
    if (!q || q.length === 0) return null;
    const id = q.shift();
    if (q.length === 0) deferredQueues.delete(normalizedUrl);
    return id;
  }

  /** Purge a requestId from every queue (used when a request is cancelled). */
  function remove(requestId) {
    for (const [url, q] of deferredQueues) {
      const idx = q.indexOf(requestId);
      if (idx !== -1) {
        q.splice(idx, 1);
        if (q.length === 0) deferredQueues.delete(url);
      }
    }
  }

  /** Snapshot of URLs that still have deferred requestIds waiting. */
  function listDeferredUrls() {
    return [...deferredQueues.keys()];
  }

  return { isProcessing, defer, hasDeferred, takeDeferred, remove, listDeferredUrls };
}
