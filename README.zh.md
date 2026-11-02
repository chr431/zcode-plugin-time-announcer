# time-announcer

一个 ZCode 插件：在恰当的时刻把**当前时间、时区和经过时长**告诉 agent，避免它凭感觉估计时间。行为尽可能对齐 DeepSeek Harness 的 [`time-context`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/time-context) 插件。

agent 会收到三条信息：

```text
Time sampled while preparing turn 2, step 1: 2026-11-02T22:07:19+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 12m 3s.
```

它通过 ZCode 的 hook 上下文（`<system-reminder>`）注入，而不是作为用户消息。

## 为什么需要它

模型不擅长估算流逝的时间。过期的“现在”会导致截止时间算错、回答错“今天几号”、在生成的代码里写错时间戳，或者为了运行一次 `date` 白白多调一次工具。这个插件让上下文里始终有一份新的、机器生成的时间读数。

## 安装

### 作为 ZCode 插件市场（推荐）

1. 打开 **设置 → 插件市场 → 添加 → 添加插件市场**。
2. 粘贴本仓库的 URL，或本地克隆路径。
3. 打开 **个人 → time-announcer → 安装**。
4. **新建任务**。已有任务可能保留旧的能力清单。

### 本地开发

把仓库目录加入 ZCode 的插件目录（例如 `~/.zcode/cli/config.json` 里的 `plugins.dirs`），然后在 **设置 → 插件** 中启用 `time-announcer`。插件 hook 会自动启用 hook 运行器，不需要手动设置 `hooks.enabled: true`。

## agent 看到什么

新回合开始时：

```text
Time sampled while preparing turn 1, step 1: 2026-11-02T22:07:19+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: unavailable.
```

长时间工具步骤之后（默认：距上次读数至少 10 分钟）：

```text
Time sampled while preparing turn 1, step 3: 2026-11-02T22:17:21+08:00[Asia/Shanghai]
Time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding step context: 10m 2s.
```

三行格式与 DeepSeek Harness 一致：时间戳、时区策略、经过时长。第 1 步从最近一条模型可见消息起算；后续步骤从同一回合的上一条读数起算。缺少基线时显示 `unavailable`；挂钟倒退时经过时长钳制为 `0s`。

## 什么时候播报

| ZCode hook | 行为 |
|---|---|
| `UserPromptSubmit` | 新回合第 1 步。默认每个新回合都注入一次读数。 |
| `PostToolUse` / `PostToolUseFailure` | 后续步骤。距上次读数达到 `refresh_interval_ms` 时才注入。 |
| `Stop` | 更新模型可见基线。**不注入、不阻塞。** |
| `SessionStart` | `startup`/`clear` 重置状态，`resume`/`compact` 保留状态。不注入。 |

## 配置

在 **设置 → 插件 → time-announcer** 中设置。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `time_zone` | `""`（系统时区） | 显示时区，IANA 名称，如 `Asia/Shanghai`。无效值会回退到系统时区并给出警告。 |
| `refresh_interval_ms` | `600000`（10 分钟） | 两次持久读数之间的最小间隔。`0` 表示每个符合条件的步骤都注入。 |
| `inject_on_every_turn` | `"true"` | 每个新用户回合都注入。设为 `"false"` 可恢复 DeepSeek Harness 的严格全局间隔。 |

ZCode 不会在 hook 参数里展开 `${user_config.*}`，所以 hook 直接从 ZCode 的 `plugins.options[pluginId]` 读取配置。手动运行时，可以用环境变量或 hook 命令行参数覆盖：

```bash
TIME_ANNOUNCER_TIME_ZONE=UTC \
TIME_ANNOUNCER_REFRESH_INTERVAL_MS=0 \
TIME_ANNOUNCER_INJECT_EVERY_TURN=false \
node scripts/hook.cjs user-prompt-submit --time-zone=Asia/Tokyo
```

环境变量优先于配置文件，hook 参数优先于两者。`TIME_ANNOUNCER_CONFIG_PATH` 可固定一个配置文件；`TIME_ANNOUNCER_STATE_DIR` 可覆盖状态目录（两者主要用于测试）。

## 状态与隐私

- 每个会话一个状态文件：`ZCODE_PLUGIN_DATA/state/<sha256(session_id)>.json`。
- 原子写入；并行工具完成时用短锁串行化；超过 30 天的文件会被清理。
- 不联网、不收集遥测、不保存提示词正文。状态里只有时间戳、回合编号和步骤计数。
- hook 出错时写入 stderr 并以 `0` 退出，绝不阻塞工具调用或结束回合。

## 与 DeepSeek Harness 的对齐

行为、文案、10 分钟默认值、`0` 表示“每步”、经过时长规则、挂钟倒退钳制、无效时区回退，均对齐 `packages/context/time-context`（版本 `0.2.2-alpha.2`，commit `ce7073d`）。逐行映射与有意差异见 [docs/deepseek-harness-alignment.md](docs/deepseek-harness-alignment.md)。

主要差异在传输方式：DeepSeek 在 `agent/pre-step` 追加一条持久的 user 角色消息；ZCode 只暴露七种生命周期 hook，`additionalContext` 以 `<system-reminder>` 形式注入。当前 ZCode 运行时里 `UserPromptSubmit` 的上下文按回合生效，所以插件默认每个新回合注入一次，而不是只依赖全局间隔。把 `inject_on_every_turn` 设为 `"false"` 可恢复严格全局规则。

## 开发

需要 Node.js 18+。

```bash
npm test          # 或：node --test
```

手动冒烟测试：

```bash
echo '{"session_id":"demo","turnId":"t1"}' | node scripts/hook.cjs user-prompt-submit
```

预期：一行严格 JSON，`additionalContext` 字符串包含 `turn 1, step 1`。

目录结构：

```text
.zcode-plugin/plugin.json    清单
hooks/hooks.json             五个 ZCode hook 注册
scripts/hook.cjs             stdin/stdout hook 入口
scripts/lib/time.cjs         时间戳、时长、读数文本
scripts/lib/state.cjs        每会话状态、锁、清理
scripts/lib/config.cjs       ZCode 插件配置 + 环境变量/命令行覆盖
scripts/lib/announcer.cjs    事件 → 读数决策
test/                        node:test 测试
```

## 限制

- **需要 Node.js。** hook 从 `PATH` 调用 `node`，与参考的 auto-continue 插件相同。需要 Node.js 18+。
- **步骤编号是近似值。** ZCode 没有“每个模型步骤”的 hook。第 1 步是提示词；每次工具完成推进一步。并行工具完成可能被计成多个模型步骤。
- **没有浏览器时区。** ZCode hook 输入不携带浏览器上报的时区，因此使用配置或系统时区。DeepSeek Harness 的“混合时区让用户澄清”分支不适用。
- **hook 上下文按回合生效。** 它不是持久 user 消息；`<system-reminder>` 可见多久由 ZCode 决定。
- **手动中断的回合。** 用户按 Esc 中断时不会触发 `Stop` hook；下一次读数的基线是最后观察到的事件。

## License

[MIT](LICENSE)
