import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedOrigin, createRateLimiter } from "../agent/lib/http-guards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("isAllowedOrigin permits null, undefined, or empty origin (curl / CLI tools)", () => {
  const allowed = ["chrome-extension://abc123", "https://dlib.ptit.edu.vn"];
  assert.equal(isAllowedOrigin(null, allowed), true);
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin("", allowed), true);
});

test("isAllowedOrigin enforces exact chrome-extension id allowlisting without prefix wildcards", () => {
  const allowed = ["chrome-extension://abc123", "https://dlib.ptit.edu.vn"];
  assert.equal(isAllowedOrigin("chrome-extension://abc123", allowed), true);
  assert.equal(isAllowedOrigin("chrome-extension://evil-id", allowed), false);

  const legacyPrefixAllowed = ["chrome-extension://", "https://dlib.ptit.edu.vn"];
  assert.equal(
    isAllowedOrigin("chrome-extension://abc123", legacyPrefixAllowed),
    false,
    "extension ids must be explicit, prefix wildcard legacy rejected"
  );
});

test("isAllowedOrigin validates https domains and wildcard origins", () => {
  const allowed = ["chrome-extension://abc123", "https://dlib.ptit.edu.vn"];
  assert.equal(isAllowedOrigin("https://dlib.ptit.edu.vn", allowed), true);
  assert.equal(isAllowedOrigin("https://evil.example.com", allowed), false);

  const wildcardAllowed = ["*"];
  assert.equal(isAllowedOrigin("https://any-site.org", wildcardAllowed), true);
});

test("createRateLimiter enforces maxConcurrent per IP and independent tracking", () => {
  const limiter = createRateLimiter({ maxConcurrent: 2, perMinute: 3 });
  assert.equal(limiter.onBegin("1.1.1.1"), true);
  assert.equal(limiter.onBegin("1.1.1.1"), true);
  assert.equal(limiter.onBegin("1.1.1.1"), false);

  assert.equal(limiter.onBegin("2.2.2.2"), true);

  limiter.onEnd("1.1.1.1");
  assert.equal(limiter.onBegin("1.1.1.1"), true);
});

test("createRateLimiter enforces perMinute rate limit per IP", () => {
  const limiter = createRateLimiter({ maxConcurrent: 2, perMinute: 3 });
  assert.equal(limiter.onBegin("1.1.1.1"), true);
  limiter.onEnd("1.1.1.1");
  assert.equal(limiter.onBegin("1.1.1.1"), true);
  limiter.onEnd("1.1.1.1");
  assert.equal(limiter.onBegin("1.1.1.1"), true);
  limiter.onEnd("1.1.1.1");

  assert.equal(limiter.onBegin("1.1.1.1"), false);
});

test("agent/dlib-upload-server.js imports http-guards and removes local isAllowedOrigin", () => {
  const serverJs = fs.readFileSync(path.join(rootDir, "agent/dlib-upload-server.js"), "utf8");
  assert.ok(
    /from\s+['"].*http-guards(\.js)?['"]/.test(serverJs),
    "agent/dlib-upload-server.js must import from http-guards"
  );
  assert.equal(
    /function\s+isAllowedOrigin/.test(serverJs),
    false,
    "agent/dlib-upload-server.js must not define a local function isAllowedOrigin"
  );
});
