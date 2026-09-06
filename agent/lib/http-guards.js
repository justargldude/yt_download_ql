// lib/http-guards.js — Origin allowlisting + in-memory rate limiting for
// the local dlib-upload HTTP endpoint. Pure module (no googleapis deps)
// so it is unit-testable without the agent's node_modules.

/**
 * Check a request's Origin against the allowlist.
 *
 * Rules:
 *  - null/undefined/'' origin → allowed (curl/CLI tools send no Origin)
 *  - chrome-extension://<id> → EXACT match required against an explicit
 *    'chrome-extension://<id>' entry. Prefix wildcards like
 *    'chrome-extension://' are REJECTED for extension schemes: any
 *    malicious extension can mint any origin id, so only explicitly
 *    listed extension ids may pass.
 *  - http(s) origins → '*' wildcard, trailing-'*' prefix match,
 *    scheme-prefix match (endsWith '://'), or exact match.
 */
export function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true;
  const list = allowedOrigins || [];

  if (origin.startsWith('chrome-extension://')) {
    return list.includes(origin);  // exact id match only — no wildcards
  }

  return list.some((allowed) => {
    if (allowed === '*') return true;
    if (!allowed) return false;
    if (allowed.endsWith('*')) return origin.startsWith(allowed.slice(0, -1));
    if (allowed.endsWith('://')) return origin.startsWith(allowed);
    return origin === allowed;
  });
}

/**
 * Simple in-memory rate limiter: max concurrent uploads + max uploads
 * per rolling minute, tracked per remote IP. Single-process only —
 * appropriate for the user-hosted local agent (one instance per machine).
 *
 * @param {{maxConcurrent?: number, perMinute?: number}} opts
 */
export function createRateLimiter({ maxConcurrent = 2, perMinute = 6 } = {}) {
  const concurrent = new Map();  // ip → count of active uploads
  const timestamps = new Map(); // ip → Array<number> of onBegin times

  function prune(now = Date.now()) {
    const cutoff = now - 60_000;
    for (const [ip, times] of timestamps) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) timestamps.delete(ip);
      else timestamps[ip] = kept;
    }
  }

  return {
    /**
     * Try to begin an upload for this IP. Returns true if allowed (and
     * records the concurrent slot + rolling timestamp), false otherwise.
     */
    onBegin(ip) {
      if (!ip) ip = 'unknown';
      const now = Date.now();
      prune(now);

      const active = concurrent.get(ip) || 0;
      if (active >= maxConcurrent) return false;

      const times = timestamps.get(ip) || [];
      if (times.length >= perMinute) return false;

      // Record
      concurrent.set(ip, active + 1);
      times.push(now);
      timestamps.set(ip, times);
      return true;
    },

    /** Free one concurrent slot for this IP (upload finished/failed). */
    onEnd(ip) {
      if (!ip) ip = 'unknown';
      const active = concurrent.get(ip) || 0;
      if (active <= 1) concurrent.delete(ip);
      else concurrent.set(ip, active - 1);
    },
  };
}
