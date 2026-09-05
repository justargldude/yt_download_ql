import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveConfigPaths } from "../agent/lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("config.example.json is cross-platform and contains no hardcoded /usr/bin", () => {
  const examplePath = path.join(rootDir, "agent/config.example.json");
  const raw = fs.readFileSync(examplePath, "utf8");

  assert.ok(!raw.includes("/usr/bin"), "config.example.json must not contain hardcoded /usr/bin paths");

  const parsed = JSON.parse(raw);
  assert.equal(parsed.paths.ytdlp, "yt-dlp");
  assert.equal(parsed.paths.ffmpeg, "ffmpeg");
  assert.equal(parsed.paths.outputDir, "~/YT_Queue_Output");
  assert.equal(parsed.paths.cookiesFile, "~/cookies.txt");

  const resolved = resolveConfigPaths(parsed);
  assert.equal(resolved.paths.ytdlp, "yt-dlp");
  assert.equal(resolved.paths.ffmpeg, "ffmpeg");
  assert.equal(resolved.paths.outputDir, path.join(os.homedir(), "YT_Queue_Output"));
  assert.equal(resolved.paths.cookiesFile, path.join(os.homedir(), "cookies.txt"));
});

test("config-loader.js integrates resolveConfigPaths", () => {
  const loaderSrc = fs.readFileSync(path.join(rootDir, "agent/config-loader.js"), "utf8");
  assert.ok(loaderSrc.includes("resolveConfigPaths"), "config-loader.js must import and call resolveConfigPaths");
});

test("start-agent.sh exists and provides portable auto-restart loop", () => {
  const shPath = path.join(rootDir, "agent/start-agent.sh");
  assert.ok(fs.existsSync(shPath), "agent/start-agent.sh must exist");
  const content = fs.readFileSync(shPath, "utf8");
  assert.ok(content.includes("while true"), "start-agent.sh must contain while loop");
  assert.ok(content.includes("node agent.js"), "start-agent.sh must start agent.js");
});

test("start-agent.bat exists and provides Windows auto-restart loop", () => {
  const batPath = path.join(rootDir, "agent/start-agent.bat");
  assert.ok(fs.existsSync(batPath), "agent/start-agent.bat must exist");
  const content = fs.readFileSync(batPath, "utf8");
  assert.ok(content.includes(":loop"), "start-agent.bat must contain :loop label");
  assert.ok(content.includes("%~dp0"), "start-agent.bat must use %~dp0 to set directory");
  assert.ok(content.includes("node agent.js"), "start-agent.bat must execute node agent.js");
  assert.ok(content.includes("goto loop"), "start-agent.bat must loop restart");
});

test("install-service.js contains win32 branch and aria2c check is cross-platform", () => {
  const installerSrc = fs.readFileSync(path.join(rootDir, "agent/install-service.js"), "utf8");
  assert.ok(installerSrc.includes("win32"), "install-service.js must check for win32 platform");
  assert.ok(installerSrc.includes("start-agent.bat"), "install-service.js must reference start-agent.bat");
  assert.ok(installerSrc.includes("schtasks"), "install-service.js must explain schtasks configuration");

  const processorSrc = fs.readFileSync(path.join(rootDir, "agent/processor.js"), "utf8");
  assert.ok(!processorSrc.includes("aria2cPath = '/usr/bin/aria2c';"), "processor.js must not hardcode /usr/bin/aria2c fallback");
});
