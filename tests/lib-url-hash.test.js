// tests/lib-url-hash.test.js — Canonical URL hashing single-source-of-truth
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractYouTubeVideoId, hashUrl, normalizeUrlForDedup, isLiveUrl } from '../agent/lib/url-hash.js';

describe('extractYouTubeVideoId', () => {
  test('watch URLs', () => {
    assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });
  test('short links', () => {
    assert.equal(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });
  test('live URLs', () => {
    assert.equal(extractYouTubeVideoId('https://www.youtube.com/live/abc123XYZ_-'), 'abc123XYZ_-');
  });
  test('shorts URLs', () => {
    assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/vid12345678'), 'vid12345678');
  });
  test('embed URLs', () => {
    assert.equal(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });
  test('mobile', () => {
    assert.equal(extractYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });
  test('tracking params ignored', () => {
    assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&si=xyz'), 'dQw4w9WgXcQ');
  });
  test('non-youtube → null', () => {
    assert.equal(extractYouTubeVideoId('https://example.com/watch?v=abc'), null);
  });
  test('garbage → null', () => {
    assert.equal(extractYouTubeVideoId('not a url'), null);
    assert.equal(extractYouTubeVideoId(''), null);
    assert.equal(extractYouTubeVideoId(null), null);
  });
});

describe('hashUrl — same video MUST share one cache hash', () => {
  const variants = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=99s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&si=tracking',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ];
  test('all link shapes of same video → identical hash', () => {
    const hashes = new Set(variants.map(hashUrl));
    assert.equal(hashes.size, 1, `Expected 1 hash, got ${[...hashes].join(', ')}`);
  });
  test('different videos → different hash', () => {
    assert.notEqual(hashUrl('https://youtu.be/aaaaaaaaaaa'), hashUrl('https://youtu.be/bbbbbbbbbbb'));
  });
  test('non-youtube urls hash by cleaned url, not by "youtube:undefined"', () => {
    // Regression: old inline code produced 'youtube:undefined' for non-YouTube
    // URLs, colliding ALL non-YouTube sources into one hash.
    const h1 = hashUrl('https://example.com/video1.mp4');
    const h2 = hashUrl('https://example.com/video2.mp4');
    assert.notEqual(h1, h2);
    assert.equal(hashUrl('https://example.com/video1.mp4'), hashUrl('https://example.com/video1.mp4'));
  });
  test('hash length 12 hex', () => {
    assert.match(hashUrl('https://youtu.be/dQw4w9WgXcQ'), /^[0-9a-f]{12}$/);
  });
});

describe('normalizeUrlForDedup', () => {
  test('youtube shapes collapse to yt:<id>', () => {
    assert.equal(normalizeUrlForDedup('https://youtu.be/dQw4w9WgXcQ?si=1'), 'yt:dQw4w9WgXcQ');
    assert.equal(normalizeUrlForDedup('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'yt:dQw4w9WgXcQ');
  });
  test('non-youtube passthrough', () => {
    assert.equal(normalizeUrlForDedup('https://example.com/x'), 'https://example.com/x');
  });
  test('empty → null', () => {
    assert.equal(normalizeUrlForDedup(''), null);
    assert.equal(normalizeUrlForDedup(null), null);
  });
});

describe('isLiveUrl', () => {
  test('/live/ path', () => {
    assert.equal(isLiveUrl('https://youtube.com/live/abc'), true);
  });
  test('?live= param', () => {
    assert.equal(isLiveUrl('https://youtube.com/watch?live=1'), true);
  });
  test('normal video', () => {
    assert.equal(isLiveUrl('https://youtube.com/watch?v=x'), false);
  });
});
