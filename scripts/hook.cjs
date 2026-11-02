"use strict";

// time-announcer hook entry point.
//
// Usage: node hook.cjs <session-start|user-prompt-submit|post-tool-use|post-tool-use-failure|stop> [flags]
//
// ZCode sends one JSON object on stdin. This process writes at most one strict
// JSON object to stdout:
//   { "additionalContext": "..." }
// Any failure is reported on stderr and exits 0 so the session is never
// blocked or interrupted.

const { readConfig } = require("./lib/config.cjs");
const { resolveTimeZone } = require("./lib/time.cjs");
const { applyEvent, EVENT_SET } = require("./lib/announcer.cjs");
const {
  resolveStateDir,
  statePath,
  loadState,
  saveState,
  withStateLock,
  pruneOldStates,
} = require("./lib/state.cjs");

const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 3000;

// A closed stdout must not turn a clock announcement into an unhandled error.
process.stdout.on("error", () => {});

/**
 * Read and parse the hook input. A parse failure, oversized input, missing
 * stream or timeout returns null so the caller can skip the event entirely.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (data.length + chunk.length > MAX_STDIN_BYTES) {
        finish(null);
        return;
      }
      data += chunk;
    });
    process.stdin.on("end", () => {
      const text = data.trim();
      if (text === "") return finish({});
      try {
        const parsed = JSON.parse(text);
        finish(parsed && typeof parsed === "object" ? parsed : null);
      } catch {
        finish(null);
      }
    });
    process.stdin.on("error", () => finish(null));
  });
}

/**
 * @param {string} message
 */
function warn(message) {
  try {
    process.stderr.write(`[time-announcer] ${message}\n`);
  } catch {
    // stderr may be closed; nothing useful to do.
  }
}

async function main() {
  const event = process.argv[2] || "";
  if (!EVENT_SET.has(event)) return;

  const input = await readStdinJson();
  if (input === null) return;

  // Only events that can emit a reading need configuration and a formatter.
  const needsReading = event !== "stop" && event !== "session-start";
  let config = {};
  /** @type {{ timeZone: string, formatter: Intl.DateTimeFormat }|null} */
  let zone = null;
  if (needsReading) {
    config = readConfig();
    zone = resolveTimeZone(config.timeZone);
    for (const warning of [...config.warnings, ...zone.warnings]) warn(warning);
  }

  const now = Date.now();
  const sessionId =
    typeof input.session_id === "string" && input.session_id !== ""
      ? input.session_id
      : "unknown";

  const directory = resolveStateDir();
  const file = statePath(directory, sessionId);

  /** @type {string|null} */
  let additionalContext = null;

  withStateLock(file, () => {
    const state = loadState(file, sessionId, now);
    const result = applyEvent(state, event, input, now, config, zone);
    saveState(file, state, now);
    additionalContext = result.additionalContext;
  });

  if (event === "session-start") {
    try {
      pruneOldStates(directory, undefined, now);
    } catch (error) {
      warn(`state pruning failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  if (additionalContext) {
    process.stdout.write(`${JSON.stringify({ additionalContext })}\n`);
  }
}

main().catch((error) => {
  warn(`hook error: ${error && error.stack ? error.stack : String(error)}`);
  // Exit 0: a clock announcement must never interrupt or block a session.
  process.exitCode = 0;
});
