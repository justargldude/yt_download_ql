import { test } from "node:test";
import assert from "node:assert/strict";
import { createDedupCoordinator } from "../agent/lib/dedup.js";

test("createDedupCoordinator reports processing state correctly", () => {
  const processingUrls = new Map();
  const coordinator = createDedupCoordinator({ processingUrls });

  assert.equal(coordinator.isProcessing("yt:vid1"), false);
  processingUrls.set("yt:vid1", "req_1");
  assert.equal(coordinator.isProcessing("yt:vid1"), true);
  assert.equal(coordinator.isProcessing("yt:vid2"), false);
  processingUrls.delete("yt:vid1");
  assert.equal(coordinator.isProcessing("yt:vid1"), false);
});

test("createDedupCoordinator defers and returns requests in FIFO order", () => {
  const processingUrls = new Map();
  processingUrls.set("yt:vid1", "req_1");
  const coordinator = createDedupCoordinator({ processingUrls });

  assert.equal(coordinator.hasDeferred("yt:vid1"), false);
  assert.equal(coordinator.takeDeferred("yt:vid1"), null);

  assert.equal(coordinator.defer("req_2", "yt:vid1"), true);
  assert.equal(coordinator.defer("req_3", "yt:vid1"), true);
  assert.equal(coordinator.hasDeferred("yt:vid1"), true);
  assert.equal(coordinator.hasDeferred("yt:other"), false);

  assert.equal(coordinator.takeDeferred("yt:vid1"), "req_2");
  assert.equal(coordinator.hasDeferred("yt:vid1"), true);
  assert.equal(coordinator.takeDeferred("yt:vid1"), "req_3");
  assert.equal(coordinator.hasDeferred("yt:vid1"), false);
  assert.equal(coordinator.takeDeferred("yt:vid1"), null);
});

test("createDedupCoordinator remove purges request from deferred queue", () => {
  const processingUrls = new Map();
  processingUrls.set("yt:vid1", "req_1");
  const coordinator = createDedupCoordinator({ processingUrls });

  coordinator.defer("req_a", "yt:vid1");
  coordinator.defer("req_b", "yt:vid1");
  coordinator.defer("req_c", "yt:vid1");

  coordinator.remove("req_b");
  assert.equal(coordinator.takeDeferred("yt:vid1"), "req_a");
  assert.equal(coordinator.takeDeferred("yt:vid1"), "req_c");
  assert.equal(coordinator.takeDeferred("yt:vid1"), null);
  assert.equal(coordinator.hasDeferred("yt:vid1"), false);
});

test("createDedupCoordinator handles multiple distinct URLs independently", () => {
  const processingUrls = new Map();
  const coordinator = createDedupCoordinator({ processingUrls });

  coordinator.defer("req_10", "yt:urlA");
  coordinator.defer("req_20", "yt:urlB");

  assert.equal(coordinator.takeDeferred("yt:urlB"), "req_20");
  assert.equal(coordinator.takeDeferred("yt:urlB"), null);
  assert.equal(coordinator.takeDeferred("yt:urlA"), "req_10");
  assert.equal(coordinator.takeDeferred("yt:urlA"), null);
});
