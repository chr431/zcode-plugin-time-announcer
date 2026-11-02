"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_VERSION = 1;
const STATE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const LOCK_FILE_PATTERN = /^[a-f0-9]{64}\.json\.lock$/;
const LOCK_STALE_MS = 60 * 60 * 1000;
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Blocking sleep used only while waiting for a short-lived state lock. */
function sleep(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

/**
 * Resolve the directory that holds per-session state.
 *
 * `ZCODE_PLUGIN_DATA` is injected into every plugin hook by ZCode. The
 * `TIME_ANNOUNCER_STATE_DIR` override is intended for tests and advanced use.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveStateDir(env = process.env) {
  const override = env.TIME_ANNOUNCER_STATE_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    return path.resolve(override.trim());
  }
  const pluginData = env.ZCODE_PLUGIN_DATA;
  if (typeof pluginData === "string" && pluginData.trim() !== "") {
    return path.join(path.resolve(pluginData.trim()), "state");
  }
  return path.join(os.homedir(), ".zcode", "time-announcer", "state");
}

/**
 * One state file per session, named by a hash so an arbitrary session id can
 * never escape the state directory.
 *
 * @param {string} directory
 * @param {string} sessionId
 * @returns {string}
 */
function statePath(directory, sessionId) {
  const digest = crypto.createHash("sha256").update(sessionId || "unknown").digest("hex");
  return path.join(directory, `${digest}.json`);
}

/**
 * @param {string} sessionId
 * @param {number} now
 * @returns {object}
 */
function createDefaultState(sessionId, now) {
  return {
    version: STATE_VERSION,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastInjectionAt: null,
    lastModelVisibleAt: null,
    lastHookAt: null,
    turn: {
      id: null,
      number: 0,
      step: 0,
      startedAt: null,
      lastInjectionAt: null,
      lastToolAt: null,
      toolEvents: 0,
    },
    stats: {
      injections: 0,
      turns: 0,
    },
  };
}

/** @param {unknown} value */
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function nonNegativeIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Normalize a decoded state file. Unknown/invalid fields are replaced with
 * defaults instead of being trusted.
 *
 * @param {any} raw
 * @param {string} sessionId
 * @param {number} now
 * @returns {object}
 */
function normalizeState(raw, sessionId, now) {
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION) {
    return createDefaultState(sessionId, now);
  }
  const turn = raw.turn && typeof raw.turn === "object" ? raw.turn : {};
  const stats = raw.stats && typeof raw.stats === "object" ? raw.stats : {};
  return {
    version: STATE_VERSION,
    sessionId,
    createdAt: finiteOrNull(raw.createdAt) ?? now,
    updatedAt: finiteOrNull(raw.updatedAt) ?? now,
    lastInjectionAt: finiteOrNull(raw.lastInjectionAt),
    lastModelVisibleAt: finiteOrNull(raw.lastModelVisibleAt),
    lastHookAt: finiteOrNull(raw.lastHookAt),
    turn: {
      id: typeof turn.id === "string" && turn.id !== "" ? turn.id : null,
      number: nonNegativeIntegerOr(turn.number, 0),
      step: nonNegativeIntegerOr(turn.step, 0),
      startedAt: finiteOrNull(turn.startedAt),
      lastInjectionAt: finiteOrNull(turn.lastInjectionAt),
      lastToolAt: finiteOrNull(turn.lastToolAt),
      toolEvents: nonNegativeIntegerOr(turn.toolEvents, 0),
    },
    stats: {
      injections: nonNegativeIntegerOr(stats.injections, 0),
      turns: nonNegativeIntegerOr(stats.turns, 0),
    },
  };
}

/**
 * Load one session state. A corrupt file is moved aside once so a later run
 * starts clean without deleting evidence.
 *
 * @param {string} file
 * @param {string} sessionId
 * @param {number} now
 * @returns {object}
 */
function loadState(file, sessionId, now) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeState(raw, sessionId, now);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      try {
        fs.renameSync(file, `${file}.corrupt-${now}`);
      } catch {
        // Diagnostics are best-effort; never fail the hook because of them.
      }
    }
    return createDefaultState(sessionId, now);
  }
}

/**
 * Atomically save state. The temporary file lives in the same directory so
 * rename is atomic on both POSIX and Windows volumes.
 *
 * @param {string} file
 * @param {object} state
 * @param {number} now
 */
function saveState(file, state, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = now;
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES")) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore: the following rename reports the real problem.
      }
      fs.renameSync(temporary, file);
      return;
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }
}

/**
 * Serialize read-modify-write across hook processes for the same session.
 * The hook runner may execute parallel tool events in separate processes.
 *
 * If the lock cannot be acquired within the budget, the callback still runs
 * lockless: a rare lost update is better than a missing time announcement.
 *
 * @template T
 * @param {string} file
 * @param {() => T} callback
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ locked: boolean, value: T }}
 */
function withStateLock(file, callback, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 500;
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let descriptor = null;
  const started = Date.now();
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") break;
      // A hook process normally holds the lock for a few milliseconds. A lock
      // older than an hour is left over from a crash, so reclaim it.
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        // The lock disappeared between open and stat; retry immediately.
        continue;
      }
      if (Date.now() - started >= timeoutMs) break;
      sleep(10);
    }
  }

  try {
    return { locked: descriptor !== null, value: callback() };
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore close failure.
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Another process may have cleared a stale lock; ignore.
      }
    }
  }
}

/**
 * Remove old per-session state and stale locks. Only files this plugin owns
 * are touched.
 *
 * @param {string} directory
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 * @returns {number} number of removed entries
 */
function pruneOldStates(directory, maxAgeMs = STATE_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isState = STATE_FILE_PATTERN.test(entry.name);
    const isLock = LOCK_FILE_PATTERN.test(entry.name);
    if (!isState && !isLock) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(file);
      const age = now - stat.mtimeMs;
      if (isLock && age > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        removed += 1;
      } else if (isState && age > maxAgeMs) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      // A concurrently removed file is not an error.
    }
  }
  return removed;
}

module.exports = {
  STATE_VERSION,
  resolveStateDir,
  statePath,
  createDefaultState,
  normalizeState,
  loadState,
  saveState,
  withStateLock,
  pruneOldStates,
};
