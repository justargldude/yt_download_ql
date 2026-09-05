import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  isWindows,
  augmentPathEnv,
  resolveTilde,
  resolveConfigPaths,
} from "../agent/lib/paths.js";

test("isWindows returns boolean based on process.platform", () => {
  assert.equal(typeof isWindows(), "boolean");
  assert.equal(isWindows(), process.platform === "win32");
});

test("augmentPathEnv joins with path.delimiter and preserves env", () => {
  const fakeEnv = { PATH: "/usr/bin", NODE_ENV: "test" };
  const res = augmentPathEnv(["/extra/bin", "", null], fakeEnv);
  assert.equal(res.NODE_ENV, "test");
  assert.ok(res.PATH.includes("/extra/bin"));
  assert.ok(res.PATH.includes("/usr/bin"));
  assert.ok(res.PATH.includes(path.delimiter));
  assert.equal(res.PATH, `/extra/bin${path.delimiter}/usr/bin`);

  const emptyBase = augmentPathEnv(["/custom/dir"], {});
  assert.equal(emptyBase.PATH, "/custom/dir");
});

test("resolveTilde expands leading ~ to user homedir", () => {
  const home = os.homedir();
  assert.equal(resolveTilde("~/foo"), path.join(home, "foo"));
  assert.equal(resolveTilde("~"), home);
  assert.equal(resolveTilde("/abs/path"), "/abs/path");
  assert.equal(resolveTilde("relative/path"), "relative/path");
  assert.equal(resolveTilde(null), null);
  assert.equal(resolveTilde(undefined), undefined);
});

test("resolveConfigPaths deep-clones, expands tilde, and handles commands", () => {
  const original = {
    paths: {
      ytdlp: "yt-dlp",
      ffmpeg: "bin/ffmpeg",
      outputDir: "~/YT_Queue_Output",
      cookiesFile: "~/cookies.txt",
    },
  };
  const resolved = resolveConfigPaths(original);

  assert.notEqual(resolved.paths, original.paths);
  assert.equal(resolved.paths.ytdlp, "yt-dlp");
  assert.ok(path.isAbsolute(resolved.paths.ffmpeg));
  assert.ok(resolved.paths.ffmpeg.endsWith(path.join("agent", "bin", "ffmpeg")));
  assert.equal(resolved.paths.outputDir, path.join(os.homedir(), "YT_Queue_Output"));
  assert.equal(resolved.paths.cookiesFile, path.join(os.homedir(), "cookies.txt"));
});
