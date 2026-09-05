/**
 * Smoke test — verifies node --test discovers this file and the
 * tests/ directory layout works. Intentionally trivial: it exists so
 * the pipeline's red-test discovery counter has a baseline > 0 and
 * so `npm test` / `node --test tests/` has a stable entrypoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test harness is wired up', () => {
  assert.equal(1 + 1, 2);
});
