import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function loadYTUtils() {
  const src = fs.readFileSync(path.join(rootDir, "web/app-utils.js"), "utf8");
  const mockGlobal = { crypto: globalThis.crypto };
  const fn = new Function("globalThis", "window", src + "; return globalThis.YTUtils || (typeof window !== \"undefined\" ? window.YTUtils : undefined);");
  return fn(mockGlobal, mockGlobal);
}

test("TASK 1: extractYouTubeVideoId parses all YouTube URL variants and ignores tracking params", () => {
  const YTUtils = loadYTUtils();
  assert.equal(YTUtils.extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=10s"), "dQw4w9WgXcQ");
  assert.equal(YTUtils.extractYouTubeVideoId("https://vimeo.com/12345678"), null);
  assert.equal(YTUtils.extractYouTubeVideoId("not-a-url"), null);
  assert.equal(YTUtils.extractYouTubeVideoId(""), null);
  assert.equal(YTUtils.extractYouTubeVideoId(null), null);
});

test("TASK 1: isLiveUrl identifies live stream URLs", () => {
  const YTUtils = loadYTUtils();
  assert.equal(YTUtils.isLiveUrl("https://www.youtube.com/live/dQw4w9WgXcQ"), true);
  assert.equal(YTUtils.isLiveUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&live=1"), true);
  assert.equal(YTUtils.isLiveUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), false);
});

test("TASK 1: normalizeTime rolls minutes >= 60 into hours and handles standard/edge formats", () => {
  const YTUtils = loadYTUtils();
  assert.equal(YTUtils.normalizeTime("90:00"), "01:30:00");
  assert.equal(YTUtils.normalizeTime("1:00:45"), "01:00:45");
  assert.equal(YTUtils.normalizeTime("27:35"), "00:27:35");
  assert.equal(YTUtils.normalizeTime("garbage"), null);
  assert.equal(YTUtils.normalizeTime(""), null);
});

test("TASK 1: parseSegments supports separators and rejects reversed ranges", () => {
  const YTUtils = loadYTUtils();
  const seps = ["=>", "->", "→", "—", "–", "~", "-"];
  for (const sep of seps) {
    const res = YTUtils.parseSegments(`27:00 ${sep} 27:35`);
    assert.equal(res.errors.length, 0, `Failed for separator ${sep}`);
    assert.deepEqual(res.segments, [{ start: "00:27:00", end: "00:27:35" }]);
  }

  const reversed = YTUtils.parseSegments("30:00 - 20:00");
  assert.equal(reversed.segments.length, 0);
  assert.equal(reversed.errors.length, 1);
  assert.equal(reversed.errors[0], "Dòng 1: Thời gian kết thúc phải sau thời gian bắt đầu");
});

test("TASK 1: makeRequestId generates unique req_ prefixed UUIDs", () => {
  const YTUtils = loadYTUtils();
  const ids = new Set();
  const uuidRegex = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < 1000; i++) {
    const id = YTUtils.makeRequestId();
    assert.ok(uuidRegex.test(id), `ID ${id} did not match expected UUID format`);
    ids.add(id);
  }
  assert.equal(ids.size, 1000, "All 1000 generated request IDs must be unique");
});

test("TASK 1: validation and formatting helpers work properly", () => {
  const YTUtils = loadYTUtils();
  assert.equal(YTUtils.isValidYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(YTUtils.isValidYouTubeUrl("https://example.com"), false);
  assert.equal(YTUtils.isValidEmail("test@example.com"), true);
  assert.equal(YTUtils.isValidEmail("invalid-email"), false);
  assert.equal(YTUtils.escapeAttr('" onclick="alert(1)'), "&quot; onclick=&quot;alert(1)");
  assert.equal(YTUtils.truncateUrl("https://youtube.com/watch?v=1234567890", 25), "https://youtube.com/watc…");
  const past = new Date(Date.now() - 45000).toISOString();
  assert.match(YTUtils.formatElapsed(past), /^\d+s$/);
  const past65 = new Date(Date.now() - 65000).toISOString();
  assert.match(YTUtils.formatElapsed(past65), /^1m05s$/);
});
