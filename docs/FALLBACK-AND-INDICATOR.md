# 回退机制与状态灯（CLI Bridge）

三家桥接共用的两项能力在 `core/bridge-kit.mjs` 里收敛成了**一份参数化实现**：
限流/网络失败时的回退弹窗，与实时聚合状态灯。provider 只提供差异化判据
（`isLimited` / `failureHint` / `isSuccessStatus`），骨架不再各抄一份。

---

## 一、回退机制（弹窗确认）

### 触发条件

`<id>_run` / `<id>_continue` 前台执行后，若结果 `ok === false` 且被判定为「疑似流量
受限 / 网络不通」，触发回退弹窗。判定优先用 provider 的 `isLimited(res)` 覆盖
（例如 mimo 需要认「free API service has ended / 登录 / 第三方」这类旧文案），
否则用 kit 的通用 `LIMIT_RE`（stderr + response + status 拼接命中任一）：

```
rate limit / ratelimit / 429 / too many / quota / exceed /
network / offline / ENETUNREACH / ECONNREFUSED / ECONNRESET /
ETIMEDOUT / EAI_AGAIN / ENOTFOUND / timeout / timed out /
unavailable / 503 / 502 / 500 / connection / proxy / socket /
tls / ssl / dns / 网络 / 超时 / 限流 / 流量 / 受限 / 配额 / 连接 / 断开
```

注意 kit 的两处刻意豁免：`AUTH_REQUIRED` 不弹（登录问题不是限流，弹窗只会误导）；
endpoint-mismatch 类 401 不弹（配置错误，重试无意义）。瞬时错误
（`isTransientCliError`）先静默自动重试一次，仍失败才走弹窗。

### 弹窗内容

经 DSH `userQuestions.ask()` 单选（文案 provider.label 化，三家同构）：

> **AGY 受限** —— agy 调用失败（疑似流量受限/网络不通，状态=`<status>`）。
> 是否改用 DSH 本地 API 配置继续？

| 选项 | 行为 |
| --- | --- |
| **使用 DSH 本地 API 配置（回退）** | 返回 `{ ok:false, fallback:true, status:'FALLBACK_TO_DSH', reason:<原status> }`；模型据此改用原生工具/本地模型完成任务，不再调用该 CLI。 |
| **重试 <id> 一次** | 立即再执行一次（累计最多 2 次）。 |
| **不回退（返回错误）** | 原样返回错误结果，由模型决定后续。 |

### 防阻塞 / 防循环

- **无真人应答者不弹窗**：`ask()` 抛 `CALLER_NOT_LIVE` / `DELEGATED_CALLER` 时按
  `'error'` 处理（子代理永不被弹窗卡死）；缺 `userQuestions` 服务同理。
- **最多 2 次尝试**：`attempt >= 2` 即停。
- **后台任务不弹窗**：`background:true` 完成时真人上下文未必还在，后台失败只在结果里
  提示「前台重跑才会被询问」。
- **HUNG_TIMEOUT 守卫**：`timeoutSec + 60s` 后强杀并按受限类处理（长构建要调大
  `timeoutSec`）。
- **不让 CLI 回调宿主**：policy 段明文禁止，杜绝环路。

## 二、聚合状态灯（一盏 pill，三家分区）

`home-plugin/cli-bridge-indicator` 随 DSH 启动（bundle patch 一行），每 provider
一个桶，合并三路数据源：

1. **preset 桥接事件** —— `ctx.emit('<id>/status', { snapshot })`（同进程）+
   `<id>/mode` 心跳租约；
2. **dynamic 沙箱** —— `cliBridgeCollector.mergeSnapshot(id, snap)`（旧单家收集器
   服务名保留别名）；
3. **MCP 子进程** —— `{DSH_HOME}/cli-bridge-mcp-<id>.json` 原子快照，读取时实时合并，
   超过 90s 视为停更（只清零 running，不清活动细节）。旧包快照文件
   （`codebuddy-indicator-mcp.json`、`plugins/mimo-indicator/mcp-live.json`）兼容读取。

### 租约（preset 优先态）

桥接 preset 被某会话使用时发 `<id>/mode` 心跳（30s 一跳，TTL 75s = 两跳+宽限）：

- payload 带 `sessionId` → **会话级租约**：只有该会话显示「优先」高亮；
- 缺省 → 全局租约（client 侧无法判定时的保守亮）；
- 会话关闭/桥接停用 → 租约自然过期，高亮自动灭。宿主侧 `listPresetSessions`
  （agents × composedPreset）是权威枚举，client `useSessions` 投影只是兜底 ——
  「宁可用租约到期灭，不可无来源亮」（mimo 1.2.9 灯常亮事故的对偶防线）。

### 状态语义

| 色 | state | 含义 |
| --- | --- | --- |
| 绿 | ok / idle-ready | 就绪 / 上次成功 |
| 蓝 | running | 正在派发（悬停看当前步骤） |
| 红 | failed | 上次失败（灰非红：CLI 不可用→灰） |
| 灰 | unavailable | CLI 未安装 / 找不到 exe |
| 橙 | fallback | 用户已选择回退 DSH 本地 |

`state` 是派生字段：外部快照的 state 只在 running 时被信任，其余按 provider 的
`isSuccessStatus` 本地重算（引擎 globalStatus 只认 'SUCCESS'，mimo 的 ACCEPTED 等
变体在描述符层归一 —— indicator 测试锁定此行为）。

点击 pill 展开按 provider、按项目的面板：当前步骤 + trail（12 条环）、
累计 runs / totalTokens、最近完成结果；`GET /cli-bridge/status` 返回同数据的 JSON
（旧单家路由 `/agy-indicator/status` 等保留为别名）。
