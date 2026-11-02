"use strict";

/**
 * Clock formatting helpers mirrored from deepseek-harness
 * `packages/context/time-context/src/timestamp.ts` and its `formatDuration`
 * helper. The goal is byte-for-byte compatible readings where ZCode exposes
 * the same facts.
 */

const DEFAULT_REFRESH_INTERVAL_MS = 600_000;

/**
 * Create the timestamp formatter used by durable time-context readings.
 *
 * deepseek-harness uses en-US, 24-hour fields and `longOffset` so the output
 * is an ISO-shaped local time with a numeric offset.
 *
 * @param {string|undefined|null} timeZone IANA zone, or undefined/null for the process zone.
 * @returns {Intl.DateTimeFormat}
 */
function createTimestampFormatter(timeZone) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  };
  if (typeof timeZone === "string" && timeZone.trim() !== "") {
    options.timeZone = timeZone.trim();
  }
  return new Intl.DateTimeFormat("en-US", options);
}

/**
 * Resolve the display zone once, falling back to the system zone and finally
 * UTC. A bad configured zone must never break a session, so warnings are
 * returned to the caller instead of thrown.
 *
 * @param {string|null|undefined} requested
 * @returns {{ timeZone: string, formatter: Intl.DateTimeFormat, warnings: string[] }}
 */
function resolveTimeZone(requested) {
  const warnings = [];

  if (typeof requested === "string" && requested.trim() !== "") {
    const candidate = requested.trim();
    try {
      const formatter = createTimestampFormatter(candidate);
      return {
        timeZone: formatter.resolvedOptions().timeZone,
        formatter,
        warnings,
      };
    } catch (error) {
      warnings.push(
        `invalid time zone ${JSON.stringify(candidate)}: ${error && error.message ? error.message : String(error)}; falling back to the system time zone`,
      );
    }
  }

  try {
    const formatter = createTimestampFormatter(undefined);
    return {
      timeZone: formatter.resolvedOptions().timeZone,
      formatter,
      warnings,
    };
  } catch (error) {
    warnings.push(
      `failed to resolve the system time zone: ${error && error.message ? error.message : String(error)}; falling back to UTC`,
    );
    const formatter = createTimestampFormatter("UTC");
    return { timeZone: "UTC", formatter, warnings };
  }
}

/**
 * Format epoch milliseconds as deepseek-harness does:
 * `YYYY-MM-DDTHH:mm:ss+HH:MM[IANA/Zone]`.
 *
 * @param {number} now
 * @param {Intl.DateTimeFormat} formatter
 * @param {string} timeZone
 * @returns {string}
 */
function formatTimestamp(now, formatter, timeZone) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    parts[part.type] = part.value;
  }
  const rawOffset = parts.timeZoneName || "GMT";
  const normalizedOffset = rawOffset === "UTC" ? "GMT+00:00" : rawOffset;
  const offset = normalizedOffset.startsWith("GMT")
    ? normalizedOffset.replace(/^GMT$/, "GMT+00:00").slice(3)
    : normalizedOffset;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${timeZone}]`;
}

/**
 * Format a non-negative elapsed millisecond count as compact whole-second
 * units: `2d 3h 4m 5s`, `1m 0s`, `0s`. Seconds are always present.
 *
 * @param {number} elapsedMs
 * @returns {string}
 */
function formatDuration(elapsedMs) {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Render the three-line reading. The wording follows deepseek-harness; the
 * only intentional substitution is "Time zone for this request" because a
 * ZCode hook has no browser-reported zone (the host/config zone is used).
 *
 * @param {object} input
 * @param {number} input.now
 * @param {number} input.turn
 * @param {number} input.step
 * @param {number|null|undefined} input.previous
 * @param {Intl.DateTimeFormat} input.formatter
 * @param {string} input.timeZone
 * @returns {string}
 */
function renderReading(input) {
  const { now, turn, step, previous, formatter, timeZone } = input;
  const elapsed = Number.isFinite(previous) ? formatDuration(now - previous) : "unavailable";
  const baseline = step === 1 ? "model-visible message" : "step context";
  return (
    `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n` +
    `Time zone for this request: ${timeZone}. Interpret otherwise-unqualified dates and times in this zone.\n` +
    `Elapsed since the preceding ${baseline}: ${elapsed}.`
  );
}

module.exports = {
  DEFAULT_REFRESH_INTERVAL_MS,
  createTimestampFormatter,
  resolveTimeZone,
  formatTimestamp,
  formatDuration,
  renderReading,
};
