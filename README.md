# time-announcer

A ZCode plugin that tells the agent what time it is **at the right moments**, so it does not have to guess the clock. It follows the behaviour of DeepSeek Harness's [`time-context`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/time-context) package as closely as ZCode's hook surface allows.

The agent receives a short, three-line reading:

```text
Time sampled while preparing turn 2, step 1: 2026-11-02T22:07:19+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 12m 3s.
```

It is injected as ZCode hook context (a `<system-reminder>`), not as a user message.

## Why

Models are bad at estimating elapsed time. A stale "now" leads to wrong deadlines, wrong "today" answers, wrong timestamps in generated code, and unnecessary tool calls just to run `date`. This plugin keeps a fresh, machine-generated clock reading in context.

## Install

### As a ZCode plugin marketplace (recommended)

1. Open **Settings → Plugin Marketplace → Add → Add Plugin Marketplace**.
2. Paste this repository's URL, or a local clone path.
3. Open **Personal → time-announcer → Install**.
4. Start a **new task**. Existing tasks may keep an older capability catalog.

### Local development

Add the repository directory to your ZCode plugin directories (for example `plugins.dirs` in `~/.zcode/cli/config.json`), then enable `time-announcer` in **Settings → Plugins**. Plugin hooks enable the hook runner automatically; you do not need `hooks.enabled: true`.

## What the model sees

At the start of a new turn:

```text
Time sampled while preparing turn 1, step 1: 2026-11-02T22:07:19+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: unavailable.
```

After a long-running tool step (default: at least 10 minutes since the last reading):

```text
Time sampled while preparing turn 1, step 3: 2026-11-02T22:17:21+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding step context: 10m 2s.
```

The three lines match DeepSeek Harness: timestamp, zone policy, elapsed duration. Step 1 measures from the latest preceding model-visible message; later steps measure from the previous reading in the same turn. A missing baseline is `unavailable`; a backward clock clamps elapsed time to `0s`.

## When it announces

| ZCode hook | What happens |
|---|---|
| `UserPromptSubmit` | Step 1 of a new turn. Injects a reading at every new turn by default. |
| `PostToolUse` / `PostToolUseFailure` | Later step. Injects only when `refresh_interval_ms` has elapsed since the last reading. |
| `Stop` | Updates the model-visible baseline. **Never injects or blocks.** |
| `SessionStart` | Resets state for `startup`/`clear`, preserves it for `resume`/`compact`. Does not inject. |

## Configuration

Set options in **Settings → Plugins → time-announcer**.

| Option | Default | Meaning |
|---|---|---|
| `time_zone` | `""` (system zone) | Display zone, an IANA name such as `Asia/Shanghai`. An invalid value falls back to the system zone with a warning. |
| `refresh_interval_ms` | `600000` (10 min) | Minimum time between durable readings. `0` injects at every eligible step. |
| `inject_on_every_turn` | `"true"` | Inject at every new user turn. Set to `"false"` for DeepSeek Harness's strict global interval. |

ZCode does not expand `${user_config.*}` inside hook arguments, so the hook reads the option bag from ZCode's `plugins.options[pluginId]` directly. For manual runs, these environment variables or hook flags override it:

```bash
TIME_ANNOUNCER_TIME_ZONE=UTC \
TIME_ANNOUNCER_REFRESH_INTERVAL_MS=0 \
TIME_ANNOUNCER_INJECT_EVERY_TURN=false \
node scripts/hook.cjs user-prompt-submit --time-zone=Asia/Tokyo
```

Environment variables take precedence over the config file; hook flags take precedence over both. `TIME_ANNOUNCER_CONFIG_PATH` pins one config file; `TIME_ANNOUNCER_STATE_DIR` overrides the state directory (both are mainly for tests).

## State and privacy

- One state file per session: `ZCODE_PLUGIN_DATA/state/<sha256(session_id)>.json`.
- Atomic writes, a short lock for parallel tool completions, and pruning of files older than 30 days.
- No network access, no telemetry, no prompt text. The state stores timestamps, turn numbers and step counters only.
- A hook failure is written to stderr and exits `0`; it never blocks a tool call or ends a turn.

## Alignment with DeepSeek Harness

The behaviour, wording, 10-minute default, `0` means "every step", elapsed-time rules, backward-clock clamp and invalid-zone fallback follow `packages/context/time-context` (version `0.2.2-alpha.2`, commit `ce7073d`). See [docs/deepseek-harness-alignment.md](docs/deepseek-harness-alignment.md) for the line-by-line mapping and the deliberate differences.

The main difference is transport: DeepSeek appends a durable user-role message in `agent/pre-step`; ZCode exposes only seven lifecycle hooks and injects `additionalContext` as a `<system-reminder>`. `UserPromptSubmit` context is turn-scoped in the current ZCode runtime, so the plugin defaults to one reading per turn instead of relying only on the global interval. Set `inject_on_every_turn` to `"false"` to restore the strict global rule.

## Development

Requires Node.js 18+.

```bash
npm test          # or: node --test
```

Manual smoke test:

```bash
echo '{"session_id":"demo","turnId":"t1"}' | node scripts/hook.cjs user-prompt-submit
```

Expected: one line of strict JSON with an `additionalContext` string containing `turn 1, step 1`.

Layout:

```text
.zcode-plugin/plugin.json    manifest
hooks/hooks.json             five ZCode hook registrations
scripts/hook.cjs             stdin/stdout hook entry
scripts/lib/time.cjs         timestamp, duration, reading text
scripts/lib/state.cjs        per-session state, locking, pruning
scripts/lib/config.cjs       ZCode plugin options + env/CLI overrides
scripts/lib/announcer.cjs    event → reading decisions
test/                        node:test suites
```

## Limitations

- **Node.js required.** Hooks run `node` from `PATH`, like the reference auto-continue plugin. Node.js 18+ is required.
- **Step numbers are approximate.** ZCode has no per-model-step hook. Step 1 is the prompt; every tool completion advances the step. Parallel tool completions may count as more than one model step.
- **No browser zone.** ZCode hook input does not carry a browser-reported time zone, so the configured or system zone is used. The "mixed zones ask the user" branch of DeepSeek Harness is not applicable.
- **Hook context is turn-scoped.** It is not a durable user message; ZCode decides how long the `<system-reminder>` remains visible.
- **Interrupted turns.** If a turn is manually interrupted, no `Stop` hook runs; the next reading's baseline is the last observed event.

## License

[MIT](LICENSE)
