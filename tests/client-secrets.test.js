import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('TASK 1: client code must not hardcode Telegram bot tokens or call api.telegram.org', () => {
  const appJs = fs.readFileSync(path.join(rootDir, 'web/app.js'), 'utf8');
  assert.equal(
    /8540195843:AAHBgsJ3U3oY3blgyOG9ZTXn9Rz9K3jyzwA/.test(appJs),
    false,
    'web/app.js contains hardcoded Telegram bot token'
  );
  assert.equal(
    /api\.telegram\.org/.test(appJs),
    false,
    'web/app.js directly contacts api.telegram.org from browser client'
  );
});

test('TASK 1: ptit-dlib-downloader must not hardcode secrets or fixed ngrok URLs', () => {
  const contentJs = fs.readFileSync(path.join(rootDir, 'ptit-dlib-downloader/content.js'), 'utf8');
  const popupJs = fs.readFileSync(path.join(rootDir, 'ptit-dlib-downloader/popup.js'), 'utf8');

  assert.equal(
    /ptit-dlib-2026-secret/.test(contentJs),
    false,
    'ptit-dlib-downloader/content.js contains hardcoded secret API key'
  );
  assert.equal(
    /ngrok-free\.dev/.test(contentJs),
    false,
    'ptit-dlib-downloader/content.js contains hardcoded ngrok tunnel URL'
  );
  assert.equal(
    /ngrok-free\.dev/.test(popupJs),
    false,
    'ptit-dlib-downloader/popup.js contains hardcoded ngrok tunnel URL'
  );
});

test('TASK 1: agent/telegram.js must export setupNotificationsListener for RTDB notifications queue', async () => {
  const telegramMod = await import('../agent/telegram.js');
  assert.equal(
    typeof telegramMod.setupNotificationsListener,
    'function',
    'agent/telegram.js must export setupNotificationsListener'
  );
});

test('TASK 1: .gitignore must include web/config.js', () => {
  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  assert.ok(
    /(?:^|\n)\s*web\/config\.js\s*(?:$|\n)/.test(gitignore),
    '.gitignore must ignore web/config.js to prevent committing secrets'
  );
});
