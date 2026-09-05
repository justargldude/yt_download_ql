// lib/url-hash.js — Canonical URL hashing / normalization (single source of truth).
// Previously THREE divergent implementations existed:
//   - agent/agent.js hashUrl()            (origin+pathname+'?v=' → md5, unused)
//   - agent/processor.js hashUrl()        ('youtube:'+videoId → md5)
//   - agent/cleanup.js inline recompute   (copied of processor's, drifts)
// All three could disagree for the same URL → cache misses and
// "active source" protection misses. This module is the only authority.
import crypto from 'crypto';

const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'];

/**
 * Extract the 11-char YouTube video id from any YouTube URL shape
 * (watch?v=, youtu.be/<id>, /live/<id>, /shorts/<id>, /embed/<id>,
 * /v/<id>, m., music., nocookie). Returns null for non-YouTube URLs
 * or URLs without an id.
 */
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return /^[a-zA-Z0-9_-]{6,15}$/.test(id) ? id : null;
    }
    if (!YT_HOSTS.includes(u.hostname)) return null;
    const v = u.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{6,15}$/.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['live', 'shorts', 'embed', 'v'].includes(parts[0])) {
      const id = parts[1];
      return /^[a-zA-Z0-9_-]{6,15}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Canonical cache-key hash for a source URL.
 * YouTube URLs hash by video id (so watch?v=X&t=30s and youtu.be/X share
 * the cache). Non-YouTube URLs hash the raw string. 12 hex chars.
 */
export function hashUrl(url) {
  let clean;
  if (!url) return crypto.createHash('md5').update('empty').digest('hex').slice(0, 12);
  const videoId = extractYouTubeVideoId(url);
  if (videoId) {
    clean = `youtube:${videoId}`;
  } else {
    try {
      const u = new URL(url);
      u.searchParams.delete('si');
      u.searchParams.delete('t');
      u.searchParams.delete('feature');
      u.hash = '';
      clean = u.origin + u.pathname + (u.search || '');
    } catch {
      clean = String(url);
    }
  }
  return crypto.createHash('md5').update(clean).digest('hex').slice(0, 12);
}

/**
 * Normalize a URL for in-flight deduplication: 'yt:<videoId>' for
 * YouTube (any link shape), otherwise the raw string.
 */
export function normalizeUrlForDedup(url) {
  if (!url) return null;
  const videoId = extractYouTubeVideoId(url);
  return videoId ? `yt:${videoId}` : url;
}

/**
 * Detect YouTube live-stream URL shapes (/live/<id>, ?live=...).
 */
export function isLiveUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /\/live\//i.test(url) || /[?&]live=/i.test(url);
}
