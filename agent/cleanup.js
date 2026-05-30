// cleanup.js — Tự động xóa file cũ theo lịch
import { readdir, stat, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './agent.js';

/**
 * Bắt đầu job dọn dẹp định kỳ.
 * Quét outputDir, xóa thư mục con quá hạn.
 * @param {object} config - App config
 * @returns {NodeJS.Timeout} Timer ID (có thể clearInterval)
 */
export function startCleanupJob(config) {
  const intervalMs = config.settings?.cleanupIntervalMs || 3600000; // Mặc định 1 giờ
  const maxAgeHours = config.settings?.autoDeleteAfterHours || 24;
  const outputDir = config.paths.outputDir;

  console.log(`${ts()} 🧹 Cleanup job started — interval: ${intervalMs / 60000}min, max age: ${maxAgeHours}h`);

  // Chạy lần đầu ngay khi khởi động
  runCleanup(outputDir, maxAgeHours);

  // Lặp lại định kỳ
  const timer = setInterval(() => {
    runCleanup(outputDir, maxAgeHours);
  }, intervalMs);

  // Cho phép process thoát mà không chờ timer
  timer.unref();

  return timer;
}

/**
 * Thực hiện quét và xóa thư mục cũ.
 */
async function runCleanup(outputDir, maxAgeHours) {
  if (!existsSync(outputDir)) {
    return;
  }

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
