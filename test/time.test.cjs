"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createTimestampFormatter,
  formatTimestamp,
  formatDuration,
  renderReading,
  resolveTimeZone,
} = require("../scripts/lib/time.cjs");
const { readConfig, parseNonNegativeInteger, parseBoolean } = require("../scripts/lib/config.cjs");

function timestamp(epochMs, timeZone) {
  const formatter = createTimestampFormatter(timeZone);
  return formatTimestamp(epochMs, formatter, formatter.resolvedOptions().timeZone);
}

test("formats an ISO-shaped timestamp in an IANA zone", () => {
  assert.equal(
    timestamp(Date.UTC(2026, 10, 2, 13, 56, 3), "Asia/Shanghai"),
    "2026-11-02T21:56:03+08:00[Asia/Shanghai]",
  );
});

test("formats UTC with a numeric zero offset", () => {
  assert.equal(
    timestamp(Date.UTC(2026, 10, 2, 13, 56, 3), "UTC"),
    "2026-11-02T13:56:03+00:00[UTC]",
  );
});

test("tracks daylight saving offsets", () => {
  assert.equal(
    timestamp(Date.UTC(2026, 0, 15, 12, 0, 0), "America/New_York"),
    "2026-01-15T07:00:00-05:00[America/New_York]",
  );
  assert.equal(
    timestamp(Date.UTC(2026, 6, 15, 12, 0, 0), "America/New_York"),
    "2026-07-15T08:00:00-04:00[America/New_York]",
  );
});

test("formats compact whole-second durations", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_661_000), "1h 1m 1s");
  assert.equal(formatDuration(86_400_000), "1d 0s");
  assert.equal(formatDuration(90_061_000), "1d 1h 1m 1s");
  assert.equal(formatDuration(-5000), "0s");
});

test("renders step 1 with the model-visible baseline", () => {
  const zone = resolveTimeZone("Asia/Shanghai");
  const now = Date.UTC(2026, 10, 2, 13, 56, 3);
  const text = renderReading({
    now,
    turn: 3,
    step: 1,
    previous: null,
    formatter: zone.formatter,
    timeZone: zone.timeZone,
  });
  assert.equal(
    text,
    "Time sampled while preparing turn 3, step 1: 2026-11-02T21:56:03+08:00[Asia/Shanghai]\n" +
      "Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n" +
      "Elapsed since the preceding model-visible message: unavailable.",
  );
});

test("renders later steps with the step-context baseline", () => {
  const zone = resolveTimeZone("Asia/Shanghai");
  const now = Date.UTC(2026, 10, 2, 13, 56, 3);
  const text = renderReading({
    now,
    turn: 3,
    step: 2,
    previous: now - 125_000,
    formatter: zone.formatter,
    timeZone: zone.timeZone,
  });
  assert.match(text, /step 2: 2026-11-02T21:56:03\+08:00\[Asia\/Shanghai\]/);
  assert.match(text, /Elapsed since the preceding step context: 2m 5s\.$/);
});

test("invalid time zones fall back with a warning", () => {
  const zone = resolveTimeZone("Not/AZone");
  assert.equal(zone.warnings.length, 1);
  assert.match(zone.warnings[0], /invalid time zone/);
  assert.ok(zone.formatter);
  assert.ok(zone.timeZone);
});

test("parses numeric and boolean config values strictly", () => {
  assert.deepEqual(parseNonNegativeInteger("600000", 1), { value: 600000, valid: true });
  assert.deepEqual(parseNonNegativeInteger("0", 1), { value: 0, valid: true });
  assert.deepEqual(parseNonNegativeInteger("10m", 1), { value: 1, valid: false });
  assert.deepEqual(parseNonNegativeInteger(-1, 1), { value: 1, valid: false });
  assert.deepEqual(parseBoolean("true", false), { value: true, valid: true });
  assert.deepEqual(parseBoolean("0", true), { value: false, valid: true });
  assert.deepEqual(parseBoolean("maybe", true), { value: true, valid: false });
});

test("reads plugin options from ZCode config and applies precedence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "time-announcer-config-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        options: {
          "time-announcer@time-announcer": {
            time_zone: "Asia/Tokyo",
            refresh_interval_ms: "120000",
            inject_on_every_turn: "false",
          },
        },
      },
    }),
  );

  const config = readConfig(
    {
      TIME_ANNOUNCER_CONFIG_PATH: configPath,
      ZCODE_PLUGIN_ID: "time-announcer@time-announcer",
      ZCODE_PLUGIN_NAME: "time-announcer",
    },
    [],
  );
  assert.equal(config.timeZone, "Asia/Tokyo");
  assert.equal(config.refreshIntervalMs, 120000);
  assert.equal(config.injectOnEveryTurn, false);

  const overridden = readConfig(
    {
      TIME_ANNOUNCER_CONFIG_PATH: configPath,
      ZCODE_PLUGIN_ID: "time-announcer@time-announcer",
      ZCODE_PLUGIN_NAME: "time-announcer",
      TIME_ANNOUNCER_TIME_ZONE: "Europe/Berlin",
      TIME_ANNOUNCER_REFRESH_INTERVAL_MS: "0",
      TIME_ANNOUNCER_INJECT_EVERY_TURN: "true",
    },
    [],
  );
  assert.equal(overridden.timeZone, "Europe/Berlin");
  assert.equal(overridden.refreshIntervalMs, 0);
  assert.equal(overridden.injectOnEveryTurn, true);

  const cli = readConfig(
    {
      TIME_ANNOUNCER_CONFIG_PATH: configPath,
      ZCODE_PLUGIN_ID: "time-announcer@time-announcer",
      ZCODE_PLUGIN_NAME: "time-announcer",
    },
    ["--time-zone=UTC", "--refresh-interval-ms=30000", "--inject-on-every-turn=0"],
  );
  assert.equal(cli.timeZone, "UTC");
  assert.equal(cli.refreshIntervalMs, 30000);
  assert.equal(cli.injectOnEveryTurn, false);

  fs.rmSync(directory, { recursive: true, force: true });
});
