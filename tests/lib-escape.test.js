// tests/lib-escape.test.js — HTML/Telegram escaping cho email + telegram payloads
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import để test cả export surface
const emailer = await import('../agent/emailer.js');
const telegram = await import('../agent/telegram.js');
const { escapeHtml } = await import('../agent/lib/escape.js');
const { escapeTelegram } = await import('../agent/lib/escape.js');

describe('escapeHtml (lib/escape.js + emailer re-export)', () => {
  test('escapes XSS payload', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    assert.ok(!out.includes('<img'), `must not contain raw <img: ${out}`);
    assert.ok(out.includes('&lt;img'), `must contain &lt;img: ${out}`);
  });
  test('escapes all 5 chars', () => {
    assert.equal(escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });
  test('null/undefined → empty string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
  test('emailer.js exports escapeHtml', () => {
    assert.equal(typeof emailer.escapeHtml, 'function');
  });
  test('numbers coerced safely', () => {
    assert.equal(escapeHtml(1234), '1234');
  });
});

describe('escapeTelegram (telegram path)', () => {
  test('escapes < > &', () => {
    assert.equal(escapeTelegram('<b>x</b> &'), '&lt;b&gt;x&lt;/b&gt; &amp;');
  });
  test('telegram.js exports escapeTelegram', () => {
    assert.equal(typeof telegram.escapeTelegram, 'function');
  });
  test('telegram.js exports setupNotificationsListener (RTDB relay)', () => {
    assert.equal(typeof telegram.setupNotificationsListener, 'function');
  });
  test('null/undefined → empty string', () => {
    assert.equal(escapeTelegram(null), '');
  });
});
