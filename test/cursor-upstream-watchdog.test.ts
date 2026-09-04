import assert from "node:assert/strict";
import test from "node:test";
import {
  UPSTREAM_STALL_TIMEOUT_MS,
  formatStallDuration,
  resolveUpstreamStallTimeoutMs,
  startUpstreamWatchdog,
} from "../cursor/upstream-watchdog.ts";

/**
 * With SSE keepalives holding the client connection open, the only thing that can end a turn
 * Cursor has silently abandoned is our own view of upstream progress. These tests pin that
 * watchdog: it fires once after a quiet period, any upstream frame pushes it back, and closing
 * the response retires it.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("fires once after upstream goes quiet, reporting how long it was silent", async () => {
  const fired: number[] = [];
  startUpstreamWatchdog((silentForMs) => fired.push(silentForMs), 40);
  await sleep(150);
  assert.equal(fired.length, 1, "stall callback must fire exactly once");
  assert.ok(fired[0] >= 40, `reported silence ${fired[0]}ms should be at least the timeout`);
});

test("every upstream frame pushes the deadline back", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 60);
  for (let i = 0; i < 5; i += 1) {
    await sleep(25);
    watchdog.touch();
  }
  assert.equal(fired, 0, "a stream that keeps producing frames is not stalled");
  await sleep(120);
  assert.equal(fired, 1, "once frames stop, the stall is still detected");
  watchdog.stop();
});

test("stop() retires the watchdog and later touches are inert", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 30);
  watchdog.stop();
  watchdog.touch();
  await sleep(100);
  assert.equal(fired, 0);
});

test("a non-positive timeout disables the watchdog", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 0);
  await sleep(50);
  assert.equal(fired, 0);
  watchdog.stop();
});

test("default timeout is five minutes and the env override is honoured", () => {
  assert.equal(UPSTREAM_STALL_TIMEOUT_MS, 5 * 60_000);
  assert.equal(resolveUpstreamStallTimeoutMs({}), UPSTREAM_STALL_TIMEOUT_MS);
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "120000" }), 120_000);
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "0" }), 0, "0 disables");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "soon" }), UPSTREAM_STALL_TIMEOUT_MS, "garbage falls back");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "-5" }), UPSTREAM_STALL_TIMEOUT_MS, "negative falls back");
});

test("stall durations read naturally in the error surfaced to the user", () => {
  assert.equal(formatStallDuration(300_000), "5m");
  assert.equal(formatStallDuration(90_000), "1m 30s");
  assert.equal(formatStallDuration(45_000), "45s");
  assert.equal(formatStallDuration(301_400), "5m 1s");
});
