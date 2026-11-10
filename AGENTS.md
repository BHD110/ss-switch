# Repository Guidelines

## 项目结构

这是 Windows 上的 pnpm 工作区。`apps/bridge-desktop/` 存放 Electron 主进程、preload 和打包配置，应用图标在 `build/`。`apps/bridge-web/` 存放 React 界面和 Vite 配置，界面组件在 `src/components/`。

`packages/contracts/` 定义共享类型和 IPC 通道。`packages/hosts/` 按客户端组织会话读写适配器。`packages/bridge-store/` 管理应用自己的 SQLite 数据。`packages/migrate/` 负责导入、备份和撤销，`packages/verify/` 负责写入后的校验。开发脚本和端到端测试在 `scripts/`。

## 构建与本地开发

使用 Windows、Node.js 24 或更新版本和 pnpm 10。在仓库根目录运行：

- `pnpm install` 安装工作区依赖。
- `pnpm start` 构建并启动 Electron，启动时会读取本机客户端数据。只构建时用 `pnpm build`。
- `pnpm dev:web` 启动 Vite，`pnpm dev:desktop` 持续编译 Electron 主进程和 preload。
- `pnpm typecheck` 检查各包类型。`pnpm lint` 运行 Biome 检查，`pnpm format` 应用格式和可自动修复的规则。
- `pnpm package:win` 生成 `release/win-unpacked/`，`pnpm package:portable` 生成单文件 Windows 程序。

## 代码风格

遵循 `biome.json`。TypeScript 使用两个空格缩进、双引号、语句末尾分号和多行尾逗号，目标行宽为 100 字符。React 组件文件用 PascalCase（如 `SessionList.tsx`），函数和变量用 camelCase。客户端读写逻辑放在对应的 `packages/hosts/src/<host>/` 目录。

## 测试与本地数据

`pnpm test` 运行 Vitest。将 `*.test.ts` 放在 `packages/` 或 `apps/` 内对应的 `src/` 下，用 `it(...)` 描述预期行为。目前未配置覆盖率门槛。修改导入或写入逻辑时，运行 `pnpm test:e2e` 验证复制、覆盖、撤销和分叉检测。该脚本需要本机四个 Agent 的数据库，写入只发生在临时副本上。

Codex 和 WorkBuddy 的写入器分别落在对应的 `packages/hosts/src/<host>/` 目录。修改任意写入器时，保留备份、写后校验和未知数据库版本的拒写逻辑。测试与日志中避免提交真实会话正文或数据库。

## 提交与 Pull Request

沿用 Git 历史中的 `feat:`、`fix:`、`build:`，可加范围，例如 `fix(zcode): preserve task ordering`。PR 说明变更原因、影响的客户端或模块，以及运行过的检查。有关联 issue 时附链接，界面变更附脱敏截图。
