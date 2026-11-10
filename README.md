# ss switch

本地会话中转站：在一个桌面界面里浏览 Qoder、ZCode、Codex、WorkBuddy 的本地会话，并把任意两个 Agent 之间的会话以“复制分支”的方式互相带到另一端继续。

- 只在本机读写，不联网、不上传、不做遥测。
- 切换 = 复制，不是移动。源会话保持不变；目标端新增一个可继续的会话。
- 支持“新建副本”和“覆盖已有会话”两种导回方式；覆盖只在目标自上次导入后没有新内容时可用。
- 四个 Agent 之间都是双向可写；Claude Code / Cursor 不在本版本范围内。

## 能力范围

| Agent     | 浏览 | 写入 | 说明                                                                           |
| --------- | ---- | ---- | ------------------------------------------------------------------------------ |
| Qoder CN  | 是   | 是   | JSONL + `main.sqlite`（`chat_sessions` / `chat_session_messages` / 搜索段）    |
| ZCode     | 是   | 是   | 主库 `db.sqlite` + 桌面索引 `tasks-index.sqlite`                               |
| Codex     | 是   | 是   | `sessions/**/rollout-*.jsonl` + `session_index.jsonl` + `sqlite/codex.db` 目录 |
| WorkBuddy | 是   | 是   | `workbuddy.db#sessions` + `projects/<项目>/<会话>.jsonl`                       |

互导支持四个 Agent 的任意组合（12 个方向）。工具调用、思考过程、图片/附件引用会尽量转换；目标端没有对应格式的内容会明确列为“丢弃”，不会静默吞掉。

## 安全边界

- 写入前用进程检测目标应用是否在运行；运行中默认拒绝写入（新建副本可显式勾选“仍然写入”，覆盖不允许）。
- 优先按进程判断；进程列表不可用时退回 WAL 修改时间的新鲜度。
- 写入前自动备份：Qoder 备份 `main.sqlite`（含 `-wal`/`-shm`）和目标 JSONL；ZCode 备份 `db.sqlite` 与 `tasks-index.sqlite`（含 `-wal`/`-shm`）；Codex 备份 `sqlite/codex.db`、`session_index.jsonl` 和目标 rollout；WorkBuddy 备份 `workbuddy.db`（含 `-wal`/`-shm`）和目标会话 JSONL。
- 写入在一个事务内完成，写后做行数/序列/搜索段/索引行校验；失败自动回滚。
- 覆盖已有会话前校验内容指纹；目标在导入后有了新消息就只允许“新建副本”。
- 撤销只删除 ss switch 创建的目标；覆盖模式用导入前备份还原。绝不删除源会话。
- 日志只记录 id、计数、耗时和路径，不记录会话正文。

## 快速开始

要求：Windows、Node ≥ 24、pnpm 10。

```bash
pnpm install
pnpm build
pnpm start          # 以开发方式启动（读取真实本地数据）
```

打包好的程序：目录版 `release/win-unpacked/ss switch.exe`，免安装版 `release/ss-switch-0.1.0-x64.exe`。重新打包：

```bash
pnpm package:win
```

首次启动会扫描四个 Agent 的本地数据，缓存在 `%APPDATA%\ss switch\bridge.db`。之后点“刷新”重新扫描。

## 使用方式

1. 左侧选择 Agent（或“全部会话”），中间按工作目录分组的会话列表，右侧预览统一时间线。
2. 只需要关闭**目标**应用；源应用可以继续开着。
   - 目标 Agent 自动选另一个可写的 Agent，也可以手动切换；
   - 默认“新建副本”；
   - 需要导回并替换原会话时选“覆盖已有会话”，从列表中选择 Bridge 导入过的会话。
3. 确认前会显示轮次、内容条数、工具调用数、保真度、丢弃项、备份说明和阻断原因。
4. 写入成功后可以“复制打开命令”，到目标 CLI 里 `resume`；也可以在重启目标桌面应用后从列表打开。
5. “历史”里查看每次导入、备份目录、撤销和分叉提示。

写入 Qoder、ZCode、Codex 或 WorkBuddy 前，都要先完全退出对应的目标桌面应用。原因见“安全边界”。

如果目标暂时不能关闭，可以在确认页勾选“仍然写入（需重启目标应用）”：只对“新建副本”开放，立即写库并校验，重启目标后可见；覆盖模式不允许这样写。

## 数据位置

| 内容              | 路径                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Bridge 索引与缓存 | `%APPDATA%\ss switch\bridge.db`                                                                      |
| 导入备份          | `%APPDATA%\ss switch\backups\<tx>\`                                                                  |
| Qoder 会话        | `~/.qoder-cn/projects/<slug>/<session>.jsonl` + `%APPDATA%\com.qodercn.app.stable\main.sqlite`       |
| ZCode 会话        | `~/.zcode/cli/db/db.sqlite` + `~/.zcode/v2/tasks-index.sqlite`                                       |
| Codex 会话        | `~/.codex/sessions/**/rollout-*.jsonl` + `~/.codex/session_index.jsonl` + `~/.codex/sqlite/codex.db` |
| WorkBuddy 会话    | `~/.workbuddy/workbuddy.db` + `~/.workbuddy/projects/**/*.jsonl`                                     |

## 已验证

可重复执行：

```bash
pnpm test          # 解析器 / 存储 / 导入计划 / 路径规则（21 项）
pnpm test:e2e      # 复制 → 覆盖 → 撤销 → 分叉 → 版本拒绝 → 四端往返（50 项，全部在临时副本上）
pnpm m0            # 写入器往返 + Qoder CLI 可见性（临时副本）
pnpm doctor        # 只读检查四个 Agent 的根目录、版本、会话数、写入条件
pnpm repair:zcode  # 修复已有 ZCode 导入（先退出 ZCode；自动备份由写入前流程负责）
```

已确认：

- Qoder 写入后，`qoderclicn --config-dir <tmp> --list-sessions` 能在对应工作目录列出新会话。
- Qoder 与 ZCode 的写入、覆盖、删除都在独立副本上通过；写入后读回轮次、工具调用、搜索结果一致。
- Codex 与 WorkBuddy 的写入、覆盖、撤销都在复制出来的 `codex.db` / `workbuddy.db` 上通过；Codex 写入后 rollout、`session_index.jsonl`、`local_thread_catalog` 三处一致，WorkBuddy 写入后 `sessions` 行与项目 JSONL 一致。
- Qoder→Codex→WorkBuddy 以及 Codex→WorkBuddy 的跨端复制能读回完整轮次；Codex 覆盖后撤销能还原原 rollout。
- 真实 Qoder 会话导入 ZCode 副本后，源 JSONL 哈希保持不变。
- 覆盖后的撤销能还原备份；复制后的撤销只移除新目标。
- 目标端在导入后新增内容会被标记为分叉；未知的新版本 schema 会拒绝写入（fail-closed）。

**桌面列表仍需一次人工确认**：Qoder、ZCode、Codex、WorkBuddy 的写入校验都在临时副本上完成，真实桌面列表的可见性需要在目标应用完全退出后写一次、再启动确认。额外探测确认：Qoder 桌面**不会**实时导入新出现的 JSONL（写入后 20 秒内 `chat_sessions` 没有新行），所以写入 `main.sqlite` 是必需的，并且必须重启 Qoder 才能在列表里看到新会话。Codex 与 WorkBuddy 同样写入了桌面列表所依赖的库（Codex 的 `local_thread_catalog`、WorkBuddy 的 `sessions`），需要在重启后确认。写真实库前请先完全退出目标应用，然后运行：

```bash
pnpm probe prepare   # 写入两条一次性测试会话（先备份）
# 打开 Qoder 与 ZCode，确认出现“ss switch 可见性测试”
# 完全退出两个应用
pnpm probe cleanup   # 删除测试会话，源数据不变
```

`pnpm probe status` 可查看目标索引里是否已出现这两条会话。

## 已知限制

- Qoder 的桌面列表与 CLI 列表是两套存储；ss switch 同时写 JSONL 与桌面库。桌面不会实时导入 JSONL（已实测），需要写入 DB 并重启 Qoder。
- 写入 Qoder 时会复用同一目录下真实会话的 `workspace_id` / `execution_target_json` 和最近可用的模型 key；找不到 workspace 时退回 NULL（现有数据允许）。源模型记录在 `extra_json.bridgeSourceModel`。
- ZCode 的桌面列表按 `tasks.provider` 过滤，并且要求 `session.project_id` 与真实规则一致（`proj_` + ASCII 路径段）；Bridge 现在按真实字段写入 `project_id`、`provider`、`meta_json.provider`，并预先写 `task_group_admissions` / 正数排序，避免会话被桌面归到隐藏分组。
- ZCode 冷恢复会从工具调用重建读/写状态（`readFileState`、patch）；导入无法提供这些快照，工具调用会以**文本卡片**形式导入（保留名称、输入、输出），不再写成 `tool` part。assistant 消息写入 `tokens`/`cost` 占位，否则恢复会报 `Cannot read properties of undefined (reading 'input')`。
- 已有导入记录可用 `pnpm repair:zcode` 修复（需先退出 ZCode）：修正 project/provider/metadata、补 tokens、把工具调用转为文本、调整任务排序。
- Codex 的桌面列表来自 `sqlite/codex.db#local_thread_catalog`；Bridge 同时写 rollout JSONL、`session_index.jsonl` 和目录行。导入的思考记录是普通 `summary` 文本，加密推理无法解密；工具调用写成 `function_call` + `function_call_output`。
- WorkBuddy 的桌面列表来自 `workbuddy.db#sessions`；Bridge 同时写项目 JSONL。行的 `session_settings` 里带 Bridge 标记，撤销只删除带标记的行。工具结果以内联文本保存，不会写进 `tool-results` 文件夹。
- 搜索：Qoder 会写 `chat_session_search_segments` 以保持可搜索；ZCode 会写 `searchable_text`；Codex 的 `session_index.jsonl` 只保存标题；WorkBuddy 更复杂的索引不复制。
- 附件/图片只保留引用或文本说明，不搬运二进制，保真度会标为“适配”。
- 覆盖是同 ID 替换，风险最高；任一条保护不满足就只允许“新建副本”。
- 超大会话只做截断与折叠显示；不会为了显示而修改源数据。

## 目录结构

```
apps/bridge-desktop   Electron 主进程、preload、bootstrap、electron-builder 配置
apps/bridge-web       React 19 + Vite 界面
packages/contracts    共享类型与 IPC 通道
packages/bridge-store Bridge 自有 SQLite（索引/缓存/lineage/tx/divergence）
packages/hosts        Qoder/Codex/ZCode/WorkBuddy 读取器 + 四个写入器
packages/migrate      备份、导入计划、事务、撤销、分叉检测
packages/verify       写入后断言
scripts               m0 / e2e / doctor / probe / 打包辅助
```

## 开发命令

```bash
pnpm typecheck     # 所有包
pnpm lint          # Biome
pnpm build         # 主进程 + 渲染层
pnpm package:win       # Windows 目录版（release/win-unpacked）
pnpm package:portable  # 单文件免安装版（release/ss-switch-*.exe）
```
