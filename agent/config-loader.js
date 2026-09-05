// config-loader.js — Đọc và validate file config.json
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveConfigPaths } from './lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load config.json từ thư mục agent, thoát nếu thiếu hoặc lỗi.
 * @returns {object} Parsed config object
 */
export async function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');

  if (!existsSync(configPath)) {
    console.error('❌ config.json not found!');
    console.error('   Copy config.example.json → config.json and fill in your credentials.');
    process.exit(1);
  }

  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    // Validate các trường bắt buộc
    const required = [
      'firebase.databaseURL',
      'paths.ytdlp',
      'paths.ffmpeg',
      'paths.outputDir',
    ];

    for (const key of required) {
      const parts = key.split('.');
      let val = config;
      for (const p of parts) val = val?.[p];
      if (!val) {
        console.error(`❌ Missing required config field: ${key}`);
        process.exit(1);
      }
    }

    // Cross-platform normalize: expand '~' → homedir, resolve relative
    // tool paths, keep bare command names for PATH lookup (win/linux).
    const normalized = resolveConfigPaths(config);

    // Defaults cho settings section (tránh crash nếu user thiếu section này)
    normalized.settings = {
      pollIntervalMs: 30000,
      cleanupIntervalMs: 3600000,
      sourceRetentionHours: 12,
      maxFileSizeForEmailMB: 25,
      concurrentFragments: 16,
      ...Object.fromEntries(Object.entries(config.settings || {}).filter(([, v]) => v != null)),
    };

    return normalized;
  } catch (err) {
    console.error('❌ Failed to parse config.json:', err.message);
    process.exit(1);
  }
}
