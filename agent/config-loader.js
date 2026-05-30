// config-loader.js — Đọc và validate file config.json
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

    return config;
  } catch (err) {
    console.error('❌ Failed to parse config.json:', err.message);
    process.exit(1);
  }
}
