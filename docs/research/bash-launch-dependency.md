# Subagent 派发链的 `bash` 硬依赖分析

> 分析对象：`pi-herdr-agents` 项目  
> 结论状态：**已实施**（派发改为 `herdr agent start` 原生命令）。本文是立项依据，其中的行号与调用链已过时
---

## 问题

当前每次派发 subagent 必定经由 `bash` 执行，因此在一个 PATH 上没有 `bash` 的宿主环境（纯 Windows cmd.exe / PowerShell，无 Git Bash / 无 WSL）上**必定失败**。

准确的失败条件不是「pane 的交互 shell 不是 bash」，而是「PATH 上找不到 `bash` 二进制」。

---

## 调用链（已用 codegraph 确认）

| 步骤 | 位置 | 内容 |
|---|---|---|
| 入口 | `maestro/adapters/pi/launch.ts:444` `launchPiSubagent` → `launchFreshPiSubagent`(:483) | 解析请求、建 surface/session |
| 组装命令 | `buildPiCommand`（`launch.ts:923–928`） | `cd '<targetCwd>' && PI_SUBAGENT_ID=… PI_SUBAGENT_SESSION=… <pi…> ; echo '__SUBAGENT_DONE_'$?'__'` |
| 落盘脚本 | `startPiProcess`（`launch.ts:930–956`） | 写 `subagent-scripts/<name>-<id>.sh`，前言含 `#!/bin/bash` |
| 执行 | `maestro/surfaces/herdr/herdr-surface-provider.ts:71-76` → `maestro/surfaces/herdr/terminal.ts:113` `runScriptInPane` | `writeFileSync(path, "#!/bin/bash\n…\n<command>\n", {mode:0o755})` 然后 `runInPane(pane, "bash <path>")` |
| 进终端 | `maestro/surfaces/herdr/herdr.ts:1280` `sendHerdrCommand` | `herdr pane run <pane> <command>`——整条 `bash xxx.sh` + Enter 一次写入 PTY |

---

## 涉及的 3 个 `bash` 字面量（全仓库 grep 确认）

1. `maestro/surfaces/herdr/terminal.ts:133` → `runInPane(paneId, `bash ${shellQuote(scriptPath)}`)`  ← **唯一派发链路硬依赖**
2. `maestro/surfaces/herdr/terminal.ts:127` → `#!/bin/bash`（惰性：显式 `bash <path>` 调用，不经 shebang）
3. `maestro/runtime/worktree-operations.ts:380` → `const shellNames = new Set(["bash","zsh","fish","sh","dash"])`（清理阶段 Linux `/proc` 枚举判断空闲 shell PID 用，与派发无关）

---

## 引号语义风险

`maestro/core/shell.ts:1-3`：

```ts
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
```

POSIX 单引号语法。在 cmd.exe / PowerShell 中 `'...'` 不是引用语法，路径会原样带单引号传下去 → 与 `bash` 缺失叠加为双重故障。

---

## 各环境后果

- **纯 cmd.exe / PowerShell，无 Git Bash/WSL**：**必定失败**（`bash` 不在 PATH + 单引号语义错位）。
- **Git Bash / WSL（PATH 有 bash）**：派发这一层能通过；但 `captureSurfacePiProcessIdentity`（`launch.ts:281`，默认 `linuxProcessProbe`）与 `processHolders`（`worktree-operations.ts:366-404`，走 `readdirSync("/proc")` + `process.getuid()`）在 Git Bash 下没有 `/proc`，进程身份捕获 / worktree 清理会退化或失败。
- **macOS/Linux 但 PATH 无 `bash`**：失败；若 pane shell 是 zsh 而 PATH 仍保留 `bash`，则照常工作（命令是字面量 `bash`，不跟随 `$SHELL`）。
- `isHerdrShellReady`（`herdr.ts:1187-1191`）只校验 `shellPid != null && foregroundProcessGroupId === shellPid`，**不校验 shell 名称** → 这里没有 shell 种类的隐性要求。

---

## 关键事实（说明这属于可选设计而非语法必要）

脚本正文完全 POSIX sh 兼容：`cd '<cwd>' && ENV=v <cmd>; echo '__SUBAGENT_DONE_'$?'__'`——`cd && 变量赋值前缀 命令; echo $?` 在 `sh`/`dash` 上均可运行。bash 依赖纯粹来自调用字面量，不是脚本语法需求。

---

## 修复方案（供讨论，尚未实施）

- **方案 A（最小改动）**：把 `terminal.ts:133` 的 `bash` 改为可配置的 shell 解析——优先 `$SHELL`（或新增配置键，如 `surface.shell`），回退探测 `bash` → `sh`。同时把 `terminal.ts:127` 的 shebang 同步为所选解释器。影响面 1 个文件，约 5-10 行。
- **方案 B（彻底解耦，推荐但代价更高）**：去掉 shell 脚本这一层，改用 Herdr 的原生参数化 pane 启动（若 Herdr 支持 `pane create --cmd` / `pane run --argv`），避免生成 .sh 文件与 POSIX 引号依赖。需要确认 Herdr CLI 是否提供 argv 级入口；`herdr.ts` 目前只暴露 `pane run <pane> <text>` 文本注入（`herdr.ts:1280-1284`）。
- **方案 C（Windows 专治，不建议单独做）**：仅处理 `shellQuote` 的平台分支。不治本，因为 `bash` 字面量仍在。
- **配套（无论选哪个方案都建议）**：`terminal.ts:116-124` 的未传 `scriptPath` 回退写到 `os.tmpdir()/pi-herdr-subagent-scripts/cmd-*.sh`，与项目 AGENTS.md「禁止读写全局临时目录」冲突；派发路径始终显式传 artifactDir 路径故未触发，但回退分支存在，建议一并改为写入项目内目录或移除回退。

---

## 相关但未阻塞的点

- `maestro/adapters/pi/launch.ts:927`：`request.handoff` 时命令末尾不加 `__SUBAGENT_DONE_` 哨兵。
- `maestro/surfaces/fake/fake-surface-provider.ts:162`：fake surface 有独立 `runScript`，不走 bash（测试替身）。

---

## 备注

分析时 `.codegraph/` 索引处于 corrupt 状态（project identity 不匹配，仓库被移动/复制），已按项目 AGENTS.md 授权自动 `codegraph init .` + `codegraph index .` 重建，`extractionStatus` 现为 ready。
