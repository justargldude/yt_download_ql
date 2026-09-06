import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDownloadArgs } from "../agent/lib/ytdlp-args.js";

test("primary download args include --force-ipv4, -o sourcePath, and url last", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    sourcePath: "/tmp/sources/test/source.mp4",
    ffmpegDir: "/usr/bin",
    useAria2c: true,
    aria2cPath: "/usr/bin/aria2c",
    concurrentFragments: 16,
  });

  assert.ok(args.includes("--force-ipv4"));
  const oIdx = args.indexOf("-o");
  assert.ok(oIdx !== -1);
  assert.equal(args[oIdx + 1], "/tmp/sources/test/source.mp4");
  assert.equal(args[args.length - 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.ok(args.includes("--downloader"));
  assert.ok(args.includes("--downloader-args"));
});

test("when useAria2c is false args contain no --downloader or --downloader-args", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    sourcePath: "/tmp/sources/test/source.mp4",
    useAria2c: false,
    aria2cPath: "/usr/bin/aria2c",
  });

  assert.equal(args.includes("--downloader"), false);
  assert.equal(args.includes("--downloader-args"), false);
  assert.equal(args[args.length - 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("when retry (useAria2c false + noContinue=true) args include --no-continue and url last", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    sourcePath: "/tmp/sources/test/source.mp4",
    useAria2c: false,
    noContinue: true,
  });

  assert.equal(args.includes("--downloader"), false);
  assert.ok(args.includes("--no-continue"));
  assert.equal(args[args.length - 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("when ytMode is browser it adds --cookies-from-browser chrome", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ytdlpMode: "browser",
  });

  const idx = args.indexOf("--cookies-from-browser");
  assert.ok(idx !== -1);
  assert.equal(args[idx + 1], "chrome");
});

test("when cookies file provided it adds --cookies with file path", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    cookiesFile: "/path/to/cookies.txt",
    ytdlpMode: "cookies",
  });

  const idx = args.indexOf("--cookies");
  assert.ok(idx !== -1);
  assert.equal(args[idx + 1], "/path/to/cookies.txt");
});

test("live URL includes --live-from-start and omits aria2c even if useAria2c is true", () => {
  const args = buildDownloadArgs({
    url: "https://www.youtube.com/live/dQw4w9WgXcQ",
    isLiveUrl: true,
    useAria2c: true,
    aria2cPath: "/usr/bin/aria2c",
  });

  assert.ok(args.includes("--live-from-start"));
  assert.ok(args.includes("--wait-for-video"));
  assert.ok(args.includes("--no-part"));
  assert.equal(args.includes("--downloader"), false);
  assert.equal(args.includes("--downloader-args"), false);
});
