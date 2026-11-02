# DeepSeek Harness alignment

This document records what was copied from DeepSeek Harness's time-context
package, what was adapted to ZCode, and what is intentionally different.

Reference:

- Repository: `https://github.com/deepseek-ai/deepseek-harness`
- Package: `packages/context/time-context`
- Version: `0.2.2-alpha.2`
- Commit inspected: `ce7073d51254c26cd63b22a60835b8f948deb447`
- Key files: `src/index.ts`, `src/timestamp.ts`, `src/request-zone.ts`,
  `tests/initialization.spec.ts`, `README.md`, `README.zh.md`

## Behaviour copied

| DeepSeek Harness | This plugin | Notes |
|---|---|---|
| Three-line reading: timestamp, zone policy, elapsed | Same three lines | The zone line says `Time zone for this request` instead of `Browser time zone for this request`; ZCode has no browser-reported zone. |
| `Intl.DateTimeFormat('en-US', { hourCycle: 'h23', timeZoneName: 'longOffset', ... })` | Same formatter | The timestamp is `YYYY-MM-DDTHH:mm:ss+HH:MM[IANA/Zone]`. |
| Compact whole-second durations `2d 3h 4m 5s`; seconds always present | Same `formatDuration` | `86400000` renders as `1d 0s`. |
| Default minimum interval `600000` ms | Same default | Configurable with `refresh_interval_ms`. |
| `refreshIntervalMs: 0` injects at every eligible step | Same | `refresh_interval_ms=0`. |
| Suppress when `now >= lastInjection && now - lastInjection < interval` | Same | A backward clock (`now < lastInjection`) does not suppress. |
| Step 1 measures from the latest preceding model-visible message | Same, via `lastModelVisibleAt` | User prompts, tool results and the final assistant message update this baseline. |
| Later steps measure from the preceding time-context event in the turn | Same, via `turn.lastInjectionAt` | If the turn has no reading yet, elapsed is `unavailable`. |
| Missing baseline → `unavailable`; backward wall clock → `0s` | Same | `Math.max(0, elapsed)`. |
| Invalid/omitted `timeZone` falls back with a clear validation error | Invalid zone warns and falls back to the system zone, then UTC | A hook must not break a session, so the throw becomes a warning. |
| Configuration `timeZone`, `refreshIntervalMs` | `time_zone`, `refresh_interval_ms` | Also `inject_on_every_turn`, a ZCode transport adaptation. |
| Append-only readings; no rewriting of previous content | Hook context is appended | ZCode wraps it in a `<system-reminder>`; it is not a durable user message. |
| Turn-scoped zone facts retain facts from compacted messages | Turn counter persists across `resume`/`compact` | State is per session and survives compaction until the 30-day prune. |
| Source attribution `{ kind: 'time-context', form: 'snapshot', sections: [...] }` | Not representable in ZCode hook output | The reading text is the same; the source tag is lost. |

## Deliberate adaptations

### Transport: hook context instead of a user message

DeepSeek Harness registers an `agent/pre-step` listener and appends a durable
`UserMessage` before each eligible model call. ZCode exposes seven hooks:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `PostToolUseFailure`, `Stop`. There is no pre-model-step hook.

This plugin maps:

- `UserPromptSubmit` → step 1 of a turn.
- `PostToolUse` / `PostToolUseFailure` → a later step; the tool result is
  model-visible and the next model call follows.
- `Stop` → baseline update only.
- `SessionStart` → state initialization only.

The reading is emitted as `additionalContext`, which ZCode renders as a
`<system-reminder>` (`hook_context` for prompts, `tool_hook_context` for tool
results). It is not a user message and the source tag is not preserved.

### One reading per turn by default

DeepSeek's readings are durable, so a single reading can serve several turns
until the next 10-minute threshold. In the inspected ZCode runtime,
`UserPromptSubmit` hook context is turn-scoped (`hook_context` uses the
`per_current_turn` lifecycle). A strict global interval could therefore leave
a new turn with no fresh reading.

`inject_on_every_turn` defaults to `true`: a new turn always receives a
reading, while later tool steps still use the 10-minute interval. Set it to
`false` for DeepSeek Harness's strict global interval.

### Step numbers are approximated

DeepSeek knows the exact model-call step number. ZCode hook input has
`turnId` and `traceId`, but no step number. This plugin defines:

- step 1: a new turn's user prompt;
- step 2: the first tool completion of that turn (or a tool completion that
  starts a turn without an observed prompt);
- later steps: each additional tool completion, or a mid-turn user prompt
  with the same `turnId`.

Parallel tool completions may overcount model steps. The reading remains
truthful about the clock even when the step label is approximate.

### No browser zone / mixed-zone branch

`request-zone.ts` reads `clientTimeZone` from `user-rpc` sources, rejects
noncanonical zones, and asks the user to clarify when a turn mixes zones.
ZCode hook input does not expose a browser-reported zone. The plugin uses the
configured zone or the system zone and always renders the resolved policy
line. The mixed/unavailable branches are not applicable.

### Turn number is per-session, not the session event sequence

DeepSeek uses the session's turn number. ZCode hook input exposes an opaque
`turnId`, so the plugin keeps its own monotonic counter per session. The
counter increments whenever `turnId` changes (or on every prompt when no
`turnId` is present). It survives `resume` and `compact`; `startup`/`clear`
reset it.

## Error handling differences

DeepSeek fails plugin activation for an invalid configuration. A ZCode hook
cannot safely fail a session: a failed hook may be noisy or block work. This
plugin therefore logs invalid values to stderr, falls back to defaults, and
always exits `0`. The model sees either a valid reading or no reading.

## Tests that pin the alignment

`test/time.test.cjs` pins the formatter, duration format and reading text.
`test/announcer.test.cjs` pins the interval, baseline selection, backward
clock handling, `refresh_interval_ms=0`, turn reset and stop semantics.
`test/hook.test.cjs` exercises the real stdin/stdout process path.
