"use strict";

const { DEFAULT_REFRESH_INTERVAL_MS, renderReading } = require("./time.cjs");

const EVENT_NAMES = Object.freeze([
  "session-start",
  "user-prompt-submit",
  "post-tool-use",
  "post-tool-use-failure",
  "stop",
]);
const EVENT_SET = new Set(EVENT_NAMES);

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {any} input
 * @returns {string|null}
 */
function turnIdOf(input) {
  return typeof input.turnId === "string" && input.turnId.trim() !== ""
    ? input.turnId
    : null;
}

/** @param {any} state */
function ensureTurn(state) {
  if (!state.turn || typeof state.turn !== "object") {
    state.turn = {
      id: null,
      number: 0,
      step: 0,
      startedAt: null,
      lastInjectionAt: null,
      lastToolAt: null,
      toolEvents: 0,
    };
  }
  if (!state.stats || typeof state.stats !== "object") {
    state.stats = { injections: 0, turns: 0 };
  }
  return state.turn;
}

/**
 * Start a new turn. Turn numbers are per session and monotonic, which is the
 * ZCode analogue of deepseek-harness's session turn number.
 *
 * @param {any} state
 * @param {string|null} turnId
 * @param {number} now
 * @param {number} step
 */
function startTurn(state, turnId, now, step) {
  const turn = ensureTurn(state);
  state.turn = {
    id: turnId,
    number: (Number.isSafeInteger(turn.number) ? turn.number : 0) + 1,
    step,
    startedAt: now,
    lastInjectionAt: null,
    lastToolAt: null,
    toolEvents: 0,
  };
  state.stats.turns = (Number.isSafeInteger(state.stats.turns) ? state.stats.turns : 0) + 1;
}

/**
 * Decide whether this hook event starts a new turn, then increment its step.
 *
 * A user prompt normally starts a new turn. A prompt that shares the current
 * `turnId` (for example a queued mid-turn message) advances the step instead.
 * A tool completion is the next model step after the tool result, so it is
 * step 2 when no prompt hook was observed and `previous step + 1` otherwise.
 *
 * @param {any} state
 * @param {any} input
 * @param {string} event
 * @param {number} now
 * @returns {any}
 */
function beginOrAdvanceTurn(state, input, event, now) {
  const turn = ensureTurn(state);
  const turnId = turnIdOf(input);

  let isNew;
  if (event === "user-prompt-submit") {
    // Without a turnId every prompt is treated as a new turn; with one, only
    // a changed id starts a new turn.
    isNew = turnId === null ? true : turn.id !== turnId;
  } else if (turnId !== null) {
    isNew = turn.id !== turnId;
  } else {
    isNew = turn.step === 0;
  }

  if (isNew) {
    startTurn(state, turnId, now, event === "user-prompt-submit" ? 1 : 2);
  } else if (event === "user-prompt-submit") {
    state.turn.step = turn.step > 0 ? turn.step + 1 : 1;
  } else {
    state.turn.step = turn.step > 0 ? turn.step + 1 : 2;
  }
  return state.turn;
}

/**
 * deepseek-harness refresh-interval rule, including its treatment of a
 * backward clock: a reading that appears to come from the future does not
 * suppress the current reading.
 *
 * @param {number} now
 * @param {number|null} lastInjectionAt
 * @param {number} refreshIntervalMs
 * @returns {boolean}
 */
function intervalDue(now, lastInjectionAt, refreshIntervalMs) {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs <= 0) return true;
  if (!isFiniteNumber(lastInjectionAt)) return true;
  if (now < lastInjectionAt) return true;
  return now - lastInjectionAt >= refreshIntervalMs;
}

/**
 * @param {any} state
 * @param {number} now
 * @param {object} zone
 * @param {number|null} previous
 * @returns {string|null}
 */
function maybeInject(state, now, zone, previous) {
  if (!zone || !zone.formatter || typeof zone.timeZone !== "string") return null;
  const text = renderReading({
    now,
    turn: state.turn.number,
    step: state.turn.step,
    previous,
    formatter: zone.formatter,
    timeZone: zone.timeZone,
  });
  state.lastInjectionAt = now;
  state.turn.lastInjectionAt = now;
  state.stats.injections = (Number.isSafeInteger(state.stats.injections) ? state.stats.injections : 0) + 1;
  return text;
}

/**
 * Reset all turn and timing state for `clear`/`startup`.
 *
 * @param {any} state
 * @param {number} now
 */
function resetSession(state, now) {
  state.createdAt = now;
  state.lastInjectionAt = null;
  state.lastModelVisibleAt = null;
  state.lastHookAt = now;
  state.turn = {
    id: null,
    number: 0,
    step: 0,
    startedAt: null,
    lastInjectionAt: null,
    lastToolAt: null,
    toolEvents: 0,
  };
  state.stats = { injections: 0, turns: 0 };
}

/**
 * Apply one hook event to session state and return the text that should be
 * injected, if any.
 *
 * Mapping to deepseek-harness `agent/pre-step`:
 * - `user-prompt-submit` ≈ step 1 (turn start).
 * - `post-tool-use` / `post-tool-use-failure` ≈ a later step, because the
 *   tool result is model-visible and a new model call follows.
 * - `stop` only updates the model-visible baseline; it never blocks.
 * - `session-start` initializes/resets state; a reading is emitted at the
 *   first prompt rather than at session start.
 *
 * @param {any} state
 * @param {string} event
 * @param {any} input
 * @param {number} now
 * @param {{ refreshIntervalMs?: number, injectOnEveryTurn?: boolean }} config
 * @param {{ timeZone: string, formatter: Intl.DateTimeFormat }|null|undefined} zone
 * @returns {{ additionalContext: string|null }}
 */
function applyEvent(state, event, input, now, config, zone) {
  if (!EVENT_SET.has(event)) return { additionalContext: null };
  const hookInput = input && typeof input === "object" ? input : {};
  state.lastHookAt = now;

  if (event === "session-start") {
    const source = typeof hookInput.source === "string" ? hookInput.source : "";
    if (source === "startup" || source === "clear") {
      resetSession(state, now);
    }
    return { additionalContext: null };
  }

  if (event === "stop") {
    // The assistant's final message is the latest model-visible event. The
    // next turn's step 1 measures from it.
    state.lastModelVisibleAt = now;
    if (state.turn) state.turn.lastInjectionAt = null;
    return { additionalContext: null };
  }

  const turn = beginOrAdvanceTurn(state, hookInput, event, now);
  const previous = turn.step === 1 ? state.lastModelVisibleAt : turn.lastInjectionAt;

  if (event === "post-tool-use" || event === "post-tool-use-failure") {
    turn.lastToolAt = now;
    turn.toolEvents = (Number.isSafeInteger(turn.toolEvents) ? turn.toolEvents : 0) + 1;
  }

  // A real user prompt, assistant message and tool result are all
  // model-visible. Update the baseline after capturing `previous` so the
  // current reading still measures from the prior model-visible event.
  state.lastModelVisibleAt = now;

  const refreshIntervalMs = Number.isSafeInteger(config && config.refreshIntervalMs)
    ? config.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS;
  const injectOnEveryTurn =
    typeof (config && config.injectOnEveryTurn) === "boolean"
      ? config.injectOnEveryTurn
      : true;

  // deepseek-harness has one global minimum interval. ZCode's UserPromptSubmit
  // additionalContext is turn-scoped, so by default each new turn receives a
  // fresh reading; set inject_on_every_turn=false for the strict global rule.
  const forced = event === "user-prompt-submit" && turn.step === 1 && injectOnEveryTurn;
  const due = forced || intervalDue(now, state.lastInjectionAt, refreshIntervalMs);
  const additionalContext = due ? maybeInject(state, now, zone, previous) : null;
  return { additionalContext };
}

module.exports = {
  EVENT_NAMES,
  EVENT_SET,
  intervalDue,
  beginOrAdvanceTurn,
  applyEvent,
  resetSession,
};
