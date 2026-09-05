// cleanup.js — v4.3: Source cache cleanup (12h) + request folder cleanup
import { readdir, stat, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './lib/logger.js';
import { hashUrl } from './lib/url-hash.js';

/**
 * Bắt đầu job dọn dẹp định kỳ.
 * - sources/{hash}/: xoá sau 12h
 * - req_xxx/: xoá sau 1h (highlights đã gửi)
 */
export function startCleanupJob(config, db) {
  const intervalMs = config.settings?.cleanupIntervalMs || 3600000; // 1h
  const sourceMaxHours = config.settings?.sourceRetentionHours || 12;
  const outputDir = config.paths.outputDir;

  console.log(`${ts()} 🧹 Cleanup job started — interval: ${intervalMs / 60000}min, source retention: ${sourceMaxHours}h`);

  // Delay lần chạy đầu tiên 30s để tránh race với recovery
  setTimeout(() => runCleanup(outputDir, sourceMaxHours, db), 30000);
  const timer = setInterval(() => runCleanup(outputDir, sourceMaxHours, db), intervalMs);
  timer.unref();
  return timer;
}

async function runCleanup(outputDir, sourceMaxHours, db) {
  if (!existsSync(outputDir)) return;

  try {
    let cleaned = 0;
    const now = Date.now();

    // Lấy danh sách request đang active từ Firebase để không xóa nhầm
    let activeRequestIds = new Set();
    let activeSourceHashes = new Set();
    try {
      const snap = await db.ref('requests').once('value');
      const allReqs = snap.val() || {};
      for (const [id, req] of Object.entries(allReqs)) {
        if (['pending', 'processing'].includes(req.status)) {
          activeRequestIds.add(id);
          // Lưu source hash của request đang active (dùng hash chuẩn từ lib/url-hash.js)
          if (req.url) {
            activeSourceHashes.add(hashUrl(req.url));
          }
        }
      }
    } catch (e) {
      console.warn(`${ts()} ⚠️ Cleanup: could not fetch active requests, skipping this round`);
      return;
    }

    // ── 1. Clean request folders (req_xxx) — xóa sau 1h, skip active ──
    const entries = await readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'sources') continue;
      // Skip nếu request đang active
      if (activeRequestIds.has(entry.name)) continue;
      const dirPath = path.join(outputDir, entry.name);
      try {
        const info = await stat(dirPath);
        const ageH = (now - info.birthtimeMs) / 3600000;
        if (ageH > 1) {
          await rm(dirPath, { recursive: true, force: true });
          console.log(`${ts()} 🗑️ Cleaned request: ${entry.name} (${ageH.toFixed(1)}h old)`);
          cleaned++;
        }
      } catch (e) { /* ignore */ }
    }

    // ── 2. Clean source cache (sources/{hash}) — xoá sau sourceMaxHours ──
    const sourcesDir = path.join(outputDir, 'sources');
    if (existsSync(sourcesDir)) {
      const sources = await readdir(sourcesDir, { withFileTypes: true });
      for (const entry of sources) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(sourcesDir, entry.name);
        try {
          // Check _meta.json for download time, fallback to folder creation time
          let downloadedAt = null;
          const metaPath = path.join(dirPath, '_meta.json');
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
              downloadedAt = new Date(meta.downloaded_at).getTime();
            } catch (e) { /* ignore */ }
          }
          if (!downloadedAt) {
            const info = await stat(dirPath);
            downloadedAt = info.birthtimeMs;
          }

          const ageH = (now - downloadedAt) / 3600000;
          if (ageH > sourceMaxHours) {
            // Skip nếu source đang được dùng bởi request active
            if (activeSourceHashes.has(entry.name)) {
              continue;
            }
            // Get metadata for logging
            let url = entry.name;
            try {
              if (existsSync(metaPath)) {
                const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
                url = meta.url || entry.name;
              }
            } catch (e) { /* */ }

            await rm(dirPath, { recursive: true, force: true });
            console.log(`${ts()} 🗑️ Cleaned source: ${entry.name} (${ageH.toFixed(1)}h old)`);
            cleaned++;

            // Remove from Firebase /sources/{hash}
            if (db) {
              try { await db.ref(`sources/${entry.name}`).remove(); } catch (e) { /* */ }
            }
          }
        } catch (e) {
          console.warn(`${ts()} ⚠️ Source cleanup error: ${entry.name}: ${e.message}`);
        }
      }
    }

    if (cleaned > 0) console.log(`${ts()} 🧹 Cleanup done — ${cleaned} folder(s) removed`);
  } catch (err) {
    console.error(`${ts()} ❌ Cleanup failed: ${err.message}`);
  }
}
