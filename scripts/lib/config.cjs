"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_REFRESH_INTERVAL_MS } = require("./time.cjs");

const DEFAULT_INJECT_ON_EVERY_TURN = true;

/**
 * Parse a non-negative safe integer. Only plain decimal digits are accepted so
 * values such as "10m" or "-1" are rejected instead of being coerced.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {{ value: number, valid: boolean }}
 */
function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null) return { value: fallback, valid: true };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? { value, valid: true }
      : { value: fallback, valid: false };
  }
  const text = String(value).trim();
  if (text === "") return { value: fallback, valid: true };
  if (!/^\d+$/.test(text)) return { value: fallback, valid: false };
  const number = Number(text);
  return Number.isSafeInteger(number)
    ? { value: number, valid: true }
    : { value: fallback, valid: false };
}

/**
 * Parse a boolean-ish userConfig value.
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {{ value: boolean, valid: boolean }}
 */
function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return { value: fallback, valid: true };
  if (typeof value === "boolean") return { value, valid: true };
  const text = String(value).trim().toLowerCase();
  if (text === "") return { value: fallback, valid: true };
  if (["1", "true", "yes", "on"].includes(text)) return { value: true, valid: true };
  if (["0", "false", "no", "off"].includes(text)) return { value: false, valid: true };
  return { value: fallback, valid: false };
}

/**
 * Read and parse one JSON file. Missing or malformed files are ignored; a
 * plugin must never break a session because a config file is mid-write.
 *
 * @param {string} file
 * @returns {any|null}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Candidate ZCode configuration files. ZCode stores plugin userConfig under
 * `plugins.options[pluginId]`; workspace config can override user config.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function configCandidates(env) {
  const candidates = [];
  const explicit = env.TIME_ANNOUNCER_CONFIG_PATH;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    // An explicit path is the whole configuration source. This keeps tests
    // hermetic and lets a local install pin one file.
    return [path.resolve(explicit.trim())];
  }
  const home = os.homedir();
  candidates.push(path.join(home, ".zcode", "cli", "config.json"));
  const workspace =
    (typeof env.ZCODE_PROJECT_DIR === "string" && env.ZCODE_PROJECT_DIR.trim() !== ""
      ? env.ZCODE_PROJECT_DIR
      : process.cwd());
  candidates.push(path.join(workspace, ".zcode", "config.json"));
  candidates.push(path.join(workspace, "zcode.json"));
  return [...new Set(candidates)];
}

/**
 * Find the option bag for this plugin. The exact plugin id is preferred; a
 * `<name>@<marketplace>` key and a bare name are accepted for local installs.
 *
 * @param {any} config
 * @param {string|undefined} pluginId
 * @param {string|undefined} pluginName
 * @returns {Record<string, unknown>|null}
 */
function findPluginOptions(config, pluginId, pluginName) {
  const options = config && config.plugins && config.plugins.options;
  if (!options || typeof options !== "object") return null;
  if (typeof pluginId === "string" && pluginId !== "" && options[pluginId] && typeof options[pluginId] === "object") {
    return options[pluginId];
  }
  const names = new Set(["time-announcer"]);
  if (typeof pluginName === "string" && pluginName !== "") names.add(pluginName);
  for (const name of names) {
    if (options[name] && typeof options[name] === "object") return options[name];
    for (const [key, value] of Object.entries(options)) {
      if (key.split("@")[0] === name && value && typeof value === "object") {
        return value;
      }
    }
  }
  return null;
}

/**
 * Parse advanced hook arguments. The default hook config does not pass any;
 * they exist so a local install can be configured without editing ZCode's
 * global config.
 *
 * @param {string[]} argv arguments after the event name
 * @returns {{ timeZone?: string, refreshIntervalMs?: string, injectOnEveryTurn?: string }}
 */
function parseCliOptions(argv) {
  const result = {};
  for (const arg of argv) {
    if (arg.startsWith("--time-zone=")) result.timeZone = arg.slice("--time-zone=".length);
    else if (arg.startsWith("--refresh-interval-ms=")) {
      result.refreshIntervalMs = arg.slice("--refresh-interval-ms=".length);
    } else if (arg.startsWith("--inject-on-every-turn=")) {
      result.injectOnEveryTurn = arg.slice("--inject-on-every-turn=".length);
    }
  }
  return result;
}

/**
 * Resolve effective configuration. Precedence:
 *   1. manifest defaults (hard-coded here)
 *   2. ZCode config `plugins.options[pluginId]` (user, then workspace)
 *   3. `TIME_ANNOUNCER_*` environment variables (tests / advanced use)
 *   4. hook command-line flags (highest)
 *
 * Invalid values fall back to defaults with a warning; the hook still runs.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [argv]
 * @returns {{ timeZone: string|null, refreshIntervalMs: number, injectOnEveryTurn: boolean, warnings: string[] }}
 */
function readConfig(env = process.env, argv = process.argv.slice(3)) {
  const warnings = [];
  const fileOptions = {};

  for (const file of configCandidates(env)) {
    const config = readJson(file);
    const found = findPluginOptions(config, env.ZCODE_PLUGIN_ID, env.ZCODE_PLUGIN_NAME);
    if (found) Object.assign(fileOptions, found);
  }

  const cli = parseCliOptions(argv);
  const raw = { ...fileOptions };

  if (env.TIME_ANNOUNCER_TIME_ZONE !== undefined) raw.time_zone = env.TIME_ANNOUNCER_TIME_ZONE;
  if (env.TIME_ANNOUNCER_REFRESH_INTERVAL_MS !== undefined) {
    raw.refresh_interval_ms = env.TIME_ANNOUNCER_REFRESH_INTERVAL_MS;
  }
  if (env.TIME_ANNOUNCER_INJECT_EVERY_TURN !== undefined) {
    raw.inject_on_every_turn = env.TIME_ANNOUNCER_INJECT_EVERY_TURN;
  }
  if (cli.timeZone !== undefined) raw.time_zone = cli.timeZone;
  if (cli.refreshIntervalMs !== undefined) raw.refresh_interval_ms = cli.refreshIntervalMs;
  if (cli.injectOnEveryTurn !== undefined) raw.inject_on_every_turn = cli.injectOnEveryTurn;

  const timeZone =
    typeof raw.time_zone === "string" && raw.time_zone.trim() !== ""
      ? raw.time_zone.trim()
      : null;

  const refresh = parseNonNegativeInteger(raw.refresh_interval_ms, DEFAULT_REFRESH_INTERVAL_MS);
  if (!refresh.valid) {
    warnings.push(
      `invalid refresh_interval_ms ${JSON.stringify(raw.refresh_interval_ms)}; using ${DEFAULT_REFRESH_INTERVAL_MS} ms`,
    );
  }

  const inject = parseBoolean(raw.inject_on_every_turn, DEFAULT_INJECT_ON_EVERY_TURN);
  if (!inject.valid) {
    warnings.push(
      `invalid inject_on_every_turn ${JSON.stringify(raw.inject_on_every_turn)}; using ${DEFAULT_INJECT_ON_EVERY_TURN}`,
    );
  }

  return {
    timeZone,
    refreshIntervalMs: refresh.value,
    injectOnEveryTurn: inject.value,
    warnings,
  };
}

module.exports = {
  DEFAULT_INJECT_ON_EVERY_TURN,
  parseNonNegativeInteger,
  parseBoolean,
  configCandidates,
  findPluginOptions,
  parseCliOptions,
  readConfig,
};
