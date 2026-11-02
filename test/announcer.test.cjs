"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { applyEvent, intervalDue } = require("../scripts/lib/announcer.cjs");
const { createDefaultState } = require("../scripts/lib/state.cjs");
const { resolveTimeZone } = require("../scripts/lib/time.cjs");

const BASE = Date.UTC(2026, 10, 2, 13, 0, 0);
const ZONE = resolveTimeZone("Asia/Shanghai");
const CONFIG = { refreshIntervalMs: 600_000, injectOnEveryTurn: true };

function freshState() {
  return createDefaultState("session-1", BASE);
}

test("first prompt injects turn 1 step 1 with an unavailable baseline", () => {
  const state = freshState();
  const result = applyEvent(
    state,
    "user-prompt-submit",
    { session_id: "session-1", turnId: "turn-1" },
    BASE,
    CONFIG,
    ZONE,
  );

  assert.match(result.additionalContext, /turn 1, step 1:/);
  assert.match(result.additionalContext, /\[Asia\/Shanghai\]/);
  assert.match(result.additionalContext, /Elapsed since the preceding model-visible message: unavailable\./);
  assert.equal(state.turn.number, 1);
  assert.equal(state.turn.step, 1);
  assert.equal(state.lastInjectionAt, BASE);
  assert.equal(state.lastModelVisibleAt, BASE);
});

test("tool completions advance the step and respect the 10-minute interval", () => {
  const state = freshState();
  applyEvent(state, "user-prompt-submit", { turnId: "turn-1" }, BASE, CONFIG, ZONE);

  const early = applyEvent(
    state,
    "post-tool-use",
    { turnId: "turn-1" },
    BASE + 120_000,
    CONFIG,
    ZONE,
  );
  assert.equal(early.additionalContext, null);
  assert.equal(state.turn.step, 2);
  assert.equal(state.lastInjectionAt, BASE);

  const late = applyEvent(
    state,
    "post-tool-use",
    { turnId: "turn-1" },
    BASE + 600_000,
    CONFIG,
    ZONE,
  );
  assert.match(late.additionalContext, /turn 1, step 3:/);
  assert.match(late.additionalContext, /Elapsed since the preceding step context: 10m 0s\./);
  assert.equal(state.turn.step, 3);
  assert.equal(state.lastInjectionAt, BASE + 600_000);
});

test("a new turn is forced even inside the global interval", () => {
  const state = freshState();
  applyEvent(state, "user-prompt-submit", { turnId: "turn-1" }, BASE, CONFIG, ZONE);
  applyEvent(state, "stop", { turnId: "turn-1" }, BASE + 10_000, CONFIG, ZONE);

  const result = applyEvent(
    state,
    "user-prompt-submit",
    { turnId: "turn-2" },
    BASE + 25_000,
    CONFIG,
    ZONE,
  );
  assert.match(result.additionalContext, /turn 2, step 1:/);
  assert.match(result.additionalContext, /Elapsed since the preceding model-visible message: 15s\./);
  assert.equal(state.turn.number, 2);
});

test("strict mode applies the global interval across turns", () => {
  const strict = { refreshIntervalMs: 600_000, injectOnEveryTurn: false };
  const state = freshState();
  const first = applyEvent(state, "user-prompt-submit", { turnId: "turn-1" }, BASE, strict, ZONE);
  assert.ok(first.additionalContext);

  const second = applyEvent(
    state,
    "user-prompt-submit",
    { turnId: "turn-2" },
    BASE + 60_000,
    strict,
    ZONE,
  );
  assert.equal(second.additionalContext, null);
  assert.equal(state.turn.number, 2);
  assert.equal(state.turn.lastInjectionAt, null);

  const tool = applyEvent(
    state,
    "post-tool-use",
    { turnId: "turn-2" },
    BASE + 660_000,
    strict,
    ZONE,
  );
  assert.match(tool.additionalContext, /turn 2, step 2:/);
  assert.match(tool.additionalContext, /Elapsed since the preceding step context: unavailable\./);
});

test("a backward clock does not suppress a reading and clamps elapsed to zero", () => {
  const strict = { refreshIntervalMs: 600_000, injectOnEveryTurn: false };
  const state = freshState();
  state.lastInjectionAt = BASE;
  state.lastModelVisibleAt = BASE - 1_000;
  state.turn = {
    id: "turn-1",
    number: 1,
    step: 1,
    startedAt: BASE,
    lastInjectionAt: BASE,
    lastToolAt: null,
    toolEvents: 0,
  };

  const result = applyEvent(
    state,
    "user-prompt-submit",
    { turnId: "turn-2" },
    BASE - 1_000,
    strict,
    ZONE,
  );
  assert.match(result.additionalContext, /Elapsed since the preceding model-visible message: 0s\./);
});

test("refreshIntervalMs 0 injects at every eligible step", () => {
  const everyStep = { refreshIntervalMs: 0, injectOnEveryTurn: false };
  const state = freshState();
  applyEvent(state, "user-prompt-submit", { turnId: "turn-1" }, BASE, everyStep, ZONE);

  const tool = applyEvent(
    state,
    "post-tool-use",
    { turnId: "turn-1" },
    BASE + 1_000,
    everyStep,
    ZONE,
  );
  assert.match(tool.additionalContext, /step 2:/);
  assert.match(tool.additionalContext, /Elapsed since the preceding step context: 1s\./);

  const prompt = applyEvent(
    state,
    "user-prompt-submit",
    { turnId: "turn-1" },
    BASE + 2_000,
    everyStep,
    ZONE,
  );
  assert.match(prompt.additionalContext, /step 3:/);
  assert.match(prompt.additionalContext, /Elapsed since the preceding step context: 1s\./);
});

test("Stop updates the baseline and clears the turn injection anchor", () => {
  const state = freshState();
  applyEvent(state, "user-prompt-submit", { turnId: "turn-1" }, BASE, CONFIG, ZONE);
  const stop = applyEvent(state, "stop", { turnId: "turn-1" }, BASE + 5_000, CONFIG, ZONE);
  assert.equal(stop.additionalContext, null);
  assert.equal(state.lastModelVisibleAt, BASE + 5_000);
  assert.equal(state.turn.lastInjectionAt, null);
});

test("SessionStart clear/startup resets and resume preserves", () => {
  const state = freshState();
  state.turn.number = 4;
  state.turn.step = 3;
  state.lastInjectionAt = BASE;
  state.stats = { injections: 9, turns: 4 };

  applyEvent(state, "session-start", { source: "clear" }, BASE + 1_000, CONFIG, ZONE);
  assert.equal(state.turn.number, 0);
  assert.equal(state.turn.step, 0);
  assert.equal(state.lastInjectionAt, null);
  assert.deepEqual(state.stats, { injections: 0, turns: 0 });

  state.turn.number = 2;
  state.lastInjectionAt = BASE;
  applyEvent(state, "session-start", { source: "resume" }, BASE + 2_000, CONFIG, ZONE);
  assert.equal(state.turn.number, 2);
  assert.equal(state.lastInjectionAt, BASE);
});

test("prompts without a turnId start new turns; tool events stay in the turn", () => {
  const state = freshState();
  applyEvent(state, "user-prompt-submit", {}, BASE, CONFIG, ZONE);
  assert.equal(state.turn.number, 1);
  assert.equal(state.turn.step, 1);

  applyEvent(state, "post-tool-use", {}, BASE + 1_000, CONFIG, ZONE);
  assert.equal(state.turn.number, 1);
  assert.equal(state.turn.step, 2);

  applyEvent(state, "user-prompt-submit", {}, BASE + 2_000, CONFIG, ZONE);
  assert.equal(state.turn.number, 2);
  assert.equal(state.turn.step, 1);
});

test("intervalDue handles zero, missing and backward timestamps", () => {
  assert.equal(intervalDue(BASE, null, 600_000), true);
  assert.equal(intervalDue(BASE, BASE, 600_000), false);
  assert.equal(intervalDue(BASE + 600_000, BASE, 600_000), true);
  assert.equal(intervalDue(BASE - 1, BASE, 600_000), true);
  assert.equal(intervalDue(BASE, BASE, 0), true);
});

test("unknown events are no-ops", () => {
  const state = freshState();
  const result = applyEvent(state, "notification", {}, BASE, CONFIG, ZONE);
  assert.equal(result.additionalContext, null);
  assert.equal(state.lastHookAt, null);
});
