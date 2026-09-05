import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree, spawnOpts } from "../agent/lib/proc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("killProcessTree handles invalid and safe inputs without throwing", () => {
  const safeInputs = [
    null,
    undefined,
    {},
    { pid: undefined },
    { pid: null },
    { pid: -1 },
    { pid: 0 },
    { pid: "invalid" },
    -1,
    0,
    NaN,
    false,
    true,
  ];

  for (const input of safeInputs) {
    assert.doesNotThrow(() => {
      const result = killProcessTree(input);
      assert.equal(result, undefined);
    });
  }
});

test("spawnOpts returns expected cross-platform spawn options", () => {
  const opts = spawnOpts({ cwd: "/test/dir", env: { TEST_VAR: "value" }, detached: true });
  assert.equal(opts.cwd, "/test/dir");
  assert.deepEqual(opts.env, { TEST_VAR: "value" });
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, false);
  assert.deepEqual(opts.stdio, ["pipe", "pipe", "pipe"]);

  const defaultOpts = spawnOpts();
  assert.equal(defaultOpts.detached, true);
  assert.equal(defaultOpts.windowsHide, true);
  assert.equal(defaultOpts.shell, false);
  assert.deepEqual(defaultOpts.stdio, ["pipe", "pipe", "pipe"]);
});

test("processor.js and auth-checker.js use augmentPathEnv and no hardcoded colon join", () => {
  const processorSrc = fs.readFileSync(path.join(rootDir, "agent/processor.js"), "utf8");
  const authCheckerSrc = fs.readFileSync(path.join(rootDir, "agent/auth-checker.js"), "utf8");

  assert.ok(!processorSrc.includes(".join(':')"), "processor.js must not hardcode colon join");
  assert.ok(!authCheckerSrc.includes(".join(':')"), "auth-checker.js must not hardcode colon join");
  assert.ok(processorSrc.includes("augmentPathEnv"), "processor.js must import/use augmentPathEnv");
  assert.ok(authCheckerSrc.includes("augmentPathEnv"), "auth-checker.js must import/use augmentPathEnv");
  assert.ok(processorSrc.includes("from './lib/proc.js'") || processorSrc.includes("from \"./lib/proc.js\""), "processor.js must import from lib/proc.js");
});
