"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createDefaultState,
  loadState,
  saveState,
  statePath,
} = require("../scripts/lib/state.cjs");

const HOOK = path.join(__dirname, "..", "scripts", "hook.cjs");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "time-announcer-hook-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runHook(directory, event, input, extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK, event], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: {
      ...process.env,
      TIME_ANNOUNCER_STATE_DIR: directory,
      TIME_ANNOUNCER_CONFIG_PATH: path.join(directory, "missing-config.json"),
      TIME_ANNOUNCER_TIME_ZONE: "Asia/Shanghai",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("emits a strict JSON reading for the first prompt", (t) => {
  const directory = tempDirectory(t);
  const result = runHook(directory, "user-prompt-submit", {
    session_id: "session-first",
    turnId: "turn-1",
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["additionalContext"]);
  assert.match(
    output.additionalContext,
    /^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\[Asia\/Shanghai\]\n/,
  );
  assert.match(output.additionalContext, /Elapsed since the preceding model-visible message: unavailable\.$/);
});

test("strict mode suppresses a new turn inside the interval", (t) => {
  const directory = tempDirectory(t);
  const env = { TIME_ANNOUNCER_INJECT_EVERY_TURN: "false" };

  const first = runHook(directory, "user-prompt-submit", { session_id: "s", turnId: "t1" }, env);
  assert.ok(JSON.parse(first.stdout).additionalContext);

  const second = runHook(directory, "user-prompt-submit", { session_id: "s", turnId: "t2" }, env);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");

  const state = loadState(statePath(directory, "s"), "s", Date.now());
  assert.equal(state.turn.number, 2);
  assert.equal(state.turn.lastInjectionAt, null);
});

test("injects after the interval during tool steps", (t) => {
  const directory = tempDirectory(t);
  const now = Date.now();
  const file = statePath(directory, "s-tool");
  const state = createDefaultState("s-tool", now);
  state.lastInjectionAt = now - 600_000;
  state.lastModelVisibleAt = now - 600_000;
  state.turn = {
    id: "t1",
    number: 1,
    step: 1,
    startedAt: now - 600_000,
    lastInjectionAt: now - 600_000,
    lastToolAt: null,
    toolEvents: 0,
  };
  state.stats = { injections: 1, turns: 1 };
  saveState(file, state, now);

  const result = runHook(
    directory,
    "post-tool-use",
    { session_id: "s-tool", turnId: "t1" },
    { TIME_ANNOUNCER_INJECT_EVERY_TURN: "false" },
  );
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.match(output.additionalContext, /turn 1, step 2:/);
  assert.match(output.additionalContext, /Elapsed since the preceding step context: 10m \d+s\./);
});

test("malformed input and unknown events are silent no-ops", (t) => {
  const directory = tempDirectory(t);

  const malformed = runHook(directory, "user-prompt-submit", "not json");
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith(".json")),
    [],
  );

  const unknown = runHook(directory, "notification", { session_id: "s" });
  assert.equal(unknown.status, 0);
  assert.equal(unknown.stdout, "");
});

test("SessionStart clear resets persisted turn state", (t) => {
  const directory = tempDirectory(t);
  const now = Date.now();
  const file = statePath(directory, "s-clear");
  const state = createDefaultState("s-clear", now);
  state.turn.number = 5;
  state.turn.step = 2;
  state.lastInjectionAt = now;
  saveState(file, state, now);

  const result = runHook(directory, "session-start", { session_id: "s-clear", source: "clear" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");

  const loaded = loadState(file, "s-clear", now);
  assert.equal(loaded.turn.number, 0);
  assert.equal(loaded.turn.step, 0);
  assert.equal(loaded.lastInjectionAt, null);
});

test("Stop updates the model-visible baseline without emitting", (t) => {
  const directory = tempDirectory(t);
  const before = Date.now();
  const result = runHook(directory, "stop", { session_id: "s-stop" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");

  const loaded = loadState(statePath(directory, "s-stop"), "s-stop", Date.now());
  assert.ok(loaded.lastModelVisibleAt >= before);
});
