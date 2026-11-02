"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createDefaultState,
  loadState,
  normalizeState,
  pruneOldStates,
  resolveStateDir,
  saveState,
  statePath,
  withStateLock,
} = require("../scripts/lib/state.cjs");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "time-announcer-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("resolves the state directory from plugin data or an override", () => {
  assert.equal(
    resolveStateDir({ TIME_ANNOUNCER_STATE_DIR: "C:/tmp/time-announcer" }),
    path.resolve("C:/tmp/time-announcer"),
  );
  assert.equal(
    resolveStateDir({ ZCODE_PLUGIN_DATA: "C:/tmp/plugin-data" }),
    path.join(path.resolve("C:/tmp/plugin-data"), "state"),
  );
});

test("hashes session ids into safe file names", () => {
  const directory = path.join(os.tmpdir(), "time-announcer-state-test");
  const file = statePath(directory, "session/with/slashes and spaces");
  const expected = crypto.createHash("sha256").update("session/with/slashes and spaces").digest("hex");
  assert.equal(path.dirname(file), path.resolve(directory));
  assert.equal(path.basename(file), `${expected}.json`);
});

test("round-trips state through disk", (t) => {
  const directory = tempDirectory(t);
  const file = statePath(directory, "round-trip");
  const now = 1_800_000_000_000;
  const state = createDefaultState("round-trip", now);
  state.lastInjectionAt = now - 5_000;
  state.lastModelVisibleAt = now - 1_000;
  state.turn = {
    id: "turn-7",
    number: 7,
    step: 3,
    startedAt: now - 60_000,
    lastInjectionAt: now - 5_000,
    lastToolAt: now - 1_000,
    toolEvents: 2,
  };
  state.stats = { injections: 12, turns: 7 };
  saveState(file, state, now);

  const loaded = loadState(file, "round-trip", now + 1);
  assert.equal(loaded.lastInjectionAt, now - 5_000);
  assert.equal(loaded.turn.id, "turn-7");
  assert.equal(loaded.turn.step, 3);
  assert.deepEqual(loaded.stats, { injections: 12, turns: 7 });
});

test("normalizes unknown versions and invalid fields", (t) => {
  const directory = tempDirectory(t);
  const file = statePath(directory, "bad-version");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 0, lastInjectionAt: "not a number" }));
  const loaded = loadState(file, "bad-version", 1234);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.lastInjectionAt, null);
  assert.equal(loaded.turn.number, 0);

  const normalized = normalizeState({ version: 1, turn: { number: -3, step: 1.5 } }, "s", 99);
  assert.equal(normalized.turn.number, 0);
  assert.equal(normalized.turn.step, 0);
});

test("moves a corrupt state file aside", (t) => {
  const directory = tempDirectory(t);
  const file = statePath(directory, "corrupt");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const loaded = loadState(file, "corrupt", 777);
  assert.equal(loaded.turn.number, 0);
  const files = fs.readdirSync(directory);
  assert.ok(files.some((name) => name.startsWith(path.basename(file) + ".corrupt-")));
});

test("serializes state access and removes the lock", (t) => {
  const directory = tempDirectory(t);
  const file = statePath(directory, "lock");
  fs.mkdirSync(directory, { recursive: true });

  const result = withStateLock(file, () => {
    assert.equal(fs.existsSync(`${file}.lock`), true);
    return 42;
  });
  assert.equal(result.locked, true);
  assert.equal(result.value, 42);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("prunes old state files and stale locks only", (t) => {
  const directory = tempDirectory(t);
  const now = Date.now();
  const oldState = statePath(directory, "old");
  const freshState = statePath(directory, "fresh");
  const oldLock = `${oldState}.lock`;
  const unrelated = path.join(directory, "keep.txt");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(oldState, "{}");
  fs.writeFileSync(freshState, "{}");
  fs.writeFileSync(oldLock, "");
  fs.writeFileSync(unrelated, "keep me");

  const old = new Date(now - 40 * 24 * 60 * 60 * 1000);
  const staleLock = new Date(now - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldState, old, old);
  fs.utimesSync(oldLock, staleLock, staleLock);

  const removed = pruneOldStates(directory, undefined, now);
  assert.equal(removed, 2);
  assert.equal(fs.existsSync(oldState), false);
  assert.equal(fs.existsSync(oldLock), false);
  assert.equal(fs.existsSync(freshState), true);
  assert.equal(fs.existsSync(unrelated), true);
});
