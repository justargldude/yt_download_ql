// cleanup.js — v3.0: Tự động xóa file cũ + dọn Firebase /sources
import { readdir, stat, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './agent.js';

/**
 * Bắt đầu job dọn dẹp định kỳ.
 * @param {object} config - App config
 * @param {object} db - Firebase database reference
 * @returns {NodeJS.Timeout} Timer ID
 */
export function startCleanupJob(config, db) {
  const intervalMs = config.settings?.cleanupIntervalMs || 3600000;
  const maxAgeHours = config.settings?.autoDeleteAfterHours || 24;
  const outputDir = config.paths.outputDir;

  console.log(`${ts()} 🧹 Cleanup job started — interval: ${intervalMs / 60000}min, max age: ${maxAgeHours}h`);

  runCleanup(outputDir, maxAgeHours, db);

  const timer = setInterval(() => {
    runCleanup(outputDir, maxAgeHours, db);
  }, intervalMs);

  timer.unref();
  return timer;
}

/**
 * Thực hiện quét và xóa thư mục cũ + dọn Firebase /sources.
 */
async function runCleanup(outputDir, maxAgeHours, db) {
  if (!existsSync(outputDir)) return;

  try {
    const entries = await readdir(outputDir, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(outputDir, entry.name);

      try {
        const info = await stat(dirPath);
        const ageMs = now - info.birthtimeMs;
        const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);

        if (ageMs > maxAgeMs) {
          await rm(dirPath, { recursive: true, force: true });
          console.log(`${ts()} 🗑️  Cleaned up: ${entry.name} (age: ${ageHours}h)`);
          cleaned++;

          // Xóa source entry trong Firebase nếu khớp request_id
          if (db) {
            try {
              const sourcesSnap = await db.ref('sources')
                .orderByChild('request_id')
                .equalTo(entry.name)
                .once('value');
              const sources = sourcesSnap.val();
              if (sources) {
                for (const key of Object.keys(sources)) {
                  await db.ref(`sources/${key}`).remove();
                  console.log(`${ts()} 🗑️  Removed source registry: ${key}`);
                }
              }
            } catch (e) {
              console.warn(`${ts()} ⚠️ Firebase source cleanup failed: ${e.message}`);
            }
          }
        }
      } catch (err) {
        console.warn(`${ts()} ⚠️ Cleanup error on ${entry.name}: ${err.message}`);
      }
    }

    if (cleaned > 0) {
      console.log(`${ts()} 🧹 Cleanup complete — removed ${cleaned} folder(s)`);
    }
  } catch (err) {
    console.error(`${ts()} ❌ Cleanup scan failed: ${err.message}`);
  }
}
