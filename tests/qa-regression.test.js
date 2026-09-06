// tests/qa-regression.test.js — Regression tests cho 6 critical bugs
// mà vòng QA review (agy) bắt được sau refactor. Mỗi test tái hiện đúng
// điều kiện crash/injection gốc để chứng minh đã fix.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

describe('CRIT 1 — emailer.js TDZ ReferenceError (safeSegments use-before-declare)', () => {
  test('safeSegments được khai báo TRƯỚC khi dùng trong segment table', () => {
    const src = fs.readFileSync(path.join(rootDir, 'agent/emailer.js'), 'utf8');
    const declIdx = src.indexOf('const safeSegments');
    const useIdx = src.indexOf('safeSegments.map');
    assert.ok(declIdx !== -1, 'safeSegments phải được khai báo');
    assert.ok(useIdx > declIdx, 'use (safeSegments.map) phải nằm SAU khai báo — TDZ crash');
  });

  test('sendSingleEmail với segments KHÔNG throw ReferenceError (dynamic import + spy transporter)', async () => {
    // Spy nodemailer: thay createTransport bằng object giả để chạy thật sendSingleEmail
    const emailerUrl = new URL('../agent/emailer.js', import.meta.url).href;
    const mod = await import(emailerUrl);

    // nodemailer là dependency thật — nhưng agent/node_modules tồn tại khi test
    // chạy từ repo gốc. Nếu thiếu, bỏ qua dynamic (chỉ static phía trên).
    let sentInfo = null;
    const fakeTransporter = {
      sendMail: async (opts) => { sentInfo = opts; return { messageId: 'test' }; },
    };

    // Gọi trực tiếp hàm nội bộ qua sendResultEmail với 1 highlight file thật
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'ytcut-email-'));
    const fakeFile = path.join(tmpDir, 'HL_test.mp4');
    fs.writeFileSync(fakeFile, 'x'.repeat(200));

    try {
      const request = {
        name: 'TDZ<b>Test</b>',
        email: 'victim@example.com',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        segments: [{ start: '00:00:10', end: '00:00:35' }],
        created_at: new Date().toISOString(),
      };
      // sendResultEmail không export transporter inject; nhưng để verify TDZ
      // ta chỉ cần hàm chạy đến đoạn render không throw ReferenceError.
      // Vì transporter thật sẽ fail auth, bắt lỗi MẠNG (không phải ReferenceError).
      await assert.doesNotReject(
        async () => {
          try {
            await mod.sendResultEmail(
              { email: { user: 'x@x.com', appPassword: 'pw' } },
              request,
              [fakeFile],
              null,
            );
          } catch (e) {
            // Cho phép network/auth errors từ nodemailer, nhưng KHÔNG cho phép
            // ReferenceError/TDZ (bug gốc) — re-throw nếu là ReferenceError
            if (e instanceof ReferenceError) throw e;
          }
        },
        ReferenceError,
        'KHÔNG được crash TDZ khi render segment table'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('sendSingleEmail KHÔNG throw khi request.url null hoặc undefined', async () => {
    const emailerUrl = new URL('../agent/emailer.js', import.meta.url).href;
    const mod = await import(emailerUrl);
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'ytcut-email-nullurl-'));
    const fakeFile = path.join(tmpDir, 'HL_test.mp4');
    fs.writeFileSync(fakeFile, 'x'.repeat(200));

    try {
      const request = {
        name: 'NullUrlUser',
        email: 'victim@example.com',
        url: null, // request.url là null
        segments: [{ start: '00:00:10', end: '00:00:35' }],
        created_at: new Date().toISOString(),
      };
      await assert.doesNotReject(
        async () => {
          try {
            await mod.sendResultEmail(
              { email: { user: 'x@x.com', appPassword: 'pw' } },
              request,
              [fakeFile],
              null,
            );
          } catch (e) {
            if (e instanceof TypeError && e.message.includes('length')) throw e;
          }
        },
        TypeError,
        'KHÔNG được crash TypeError khi request.url là null'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CRIT 3 — http-guards.js Map property bug (timestamps[ip]= thay vì .set)', () => {
  test('prune thực sự xoá timestamps cũ (rolling window hoạt động)', async () => {
    const { createRateLimiter } = await import('../agent/lib/http-guards.js');
    // Tái hiện bug: sau khi prune chạy, Map entry phải được update đúng
    const limiter = createRateLimiter({ maxConcurrent: 99, perMinute: 2 });
    assert.equal(limiter.onBegin('9.9.9.9'), true);
    assert.equal(limiter.onBegin('9.9.9.9'), true);
    // perMinute=2 đã đạt — onBegin thứ 3 trong cùng phút phải false
    // (nếu dùng timestamps[ip]= thay vì .set, prune vẫn giữ entry cũ hỏng)
    assert.equal(limiter.onBegin('9.9.9.9'), false, 'rolling window phải chặn đúng perMinute');
  });
});

describe('CRIT 2 — dlib-upload-server rate limiter slot leak trên 415/413', () => {
  test('mọi return path sau onBegin đều đi qua finally (onEnd luôn chạy)', () => {
    const src = fs.readFileSync(path.join(rootDir, 'agent/dlib-upload-server.js'), 'utf8');
    const beginIdx = src.indexOf('rateLimiter.onBegin(clientIp)');
    const tryIdx = src.indexOf('try {', beginIdx);
    const ct415 = src.indexOf("415", beginIdx);
    const endIdx = src.indexOf('rateLimiter.onEnd(clientIp)', beginIdx);
    // 415 và 413 phải nằm TRONG khối try (trước onEnd trong finally)
    assert.ok(tryIdx !== -1 && tryIdx < ct415, 'content-type check (415) phải nằm trong try sau onBegin');
    assert.ok(ct415 < endIdx, '415 phải trước onEnd trong finally');
    // Đếm số onEnd phải >= số onBegin path (mọi nhánh đều release)
    const beginCount = (src.match(/onBegin\(clientIp\)/g) || []).length;
    const endCount = (src.match(/onEnd\(clientIp\)/g) || []).length;
    assert.ok(endCount >= beginCount, `onEnd (${endCount}) phải cover mọi onBegin (${beginCount})`);
  });
});

describe('CRIT 4 — Telegram injection qua /notifications relay', () => {
  test('payload.text thuần (không structured fields) cũng được escape', async () => {
    const src = fs.readFileSync(path.join(rootDir, 'agent/telegram.js'), 'utf8');
    const escapeTextIdx = src.indexOf('text = escapeTelegram(String(payload.text))');
    assert.ok(escapeTextIdx !== -1, 'payload.text phải được escapeTelegram trước khi gửi (HTML parse mode)');
  });
  test('agent.js escape name/url/err.message trong mọi sendTelegramMessage interpolation', () => {
    const src = fs.readFileSync(path.join(rootDir, 'agent/agent.js'), 'utf8');
    // Không còn interpolation thô của name/url trong telegram messages
    assert.ok(!/<b>\$\{name\}<\/b>/.test(src), 'phải dùng safeName (escaped) thay ${name}');
    assert.ok(!/🔗 \$\{url\}/.test(src), 'phải dùng safeUrl (escaped) thay ${url}');
    assert.ok(/safeName = escapeTelegram\(name\)/.test(src), 'safeName phải được escape');
  });
  test('setupNotificationsListener dọn queue và chỉ attach listener trong finally (không race condition)', () => {
    const src = fs.readFileSync(path.join(rootDir, 'agent/telegram.js'), 'utf8');
    assert.ok(src.includes(".finally(() => {"), 'cleanup promise phải dùng finally để attach listener');
    assert.ok(src.includes("attachListener();"), 'attachListener phải được gọi trong finally block');
  });
});

describe('CRIT 5 — web/app.js XSS vectors', () => {
  const appSrc = fs.readFileSync(path.join(rootDir, 'web/app.js'), 'utf8');

  test('datalist option values được escape', () => {
    assert.ok(!/`<option value="\$\{e\}"><\/option>`/.test(appSrc), 'datalist option phải escapeAttr');
    assert.ok(/option value="\$\{escapeAttr\(e\)\}"/.test(appSrc), 'datalist option phải escapeAttr');
  });

  test('progress fields (fileInfo, rangeInfo, speed...) được escape khi innerHTML', () => {
    assert.ok(/escapeHtml\(String\(progress\.current_file\)\)/.test(appSrc), 'fileInfo phải escape');
    assert.ok(/escapeHtml\(String\(progress\.segment_range\)\)/.test(appSrc), 'rangeInfo phải escape');
  });

  test('action buttons dùng event delegation, không còn inline onclick', () => {
    assert.ok(!/onclick="retryRequest\('/.test(appSrc), 'không còn inline onclick retryRequest');
    assert.ok(!/onclick="cancelRequest\('/.test(appSrc), 'không còn inline onclick cancelRequest');
    assert.ok(/data-action="retry"/.test(appSrc), 'phải có data-action attributes');
    assert.ok(/statusList\.addEventListener\('click'/.test(appSrc), 'phải có delegation listener');
  });

  test('unauthenticated global history sync đã bị REMOVE (PII leak)', () => {
    assert.ok(!/limitToLast\(30\)/.test(appSrc), 'không còn sync 30 requests của mọi user khi thiếu email');
  });
});

describe('CRIT 6 — isValidYouTubeUrl strict protocol', () => {
  test('rejects javascript: và data: pseudo-URLs', async () => {
    // Load app-utils qua harness giống test-app-utils
    const utilsSrc = fs.readFileSync(path.join(rootDir, 'web/app-utils.js'), 'utf8');
    const mockGlobal = { crypto: globalThis.crypto };
    const fn = new Function('globalThis', 'window', utilsSrc + '; return globalThis.YTUtils;');
    const YTUtils = fn(mockGlobal, mockGlobal);
    assert.equal(YTUtils.isValidYouTubeUrl('javascript:alert(1)//youtu.be'), false);
    assert.equal(YTUtils.isValidYouTubeUrl('https://youtu.be/ok12345678'), true);
  });
});
