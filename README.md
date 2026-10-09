# dsh-ralph

把 [snarktank/ralph](https://github.com/snarktank/ralph) 的自主 AI 循环改造成 **DeepSeek Harness（DSH）插件**。

Ralph 的核心思想来自 [Geoffrey Huntley 的 Ralph 模式](https://ghuntley.com/ralph/)：**反复启动全新的 AI 实例，每次只实现一个用户故事，直到 PRD 全部完成**。每次迭代上下文干净，记忆通过 git 历史、`prd.json` 与 `progress.txt` 延续。

原版通过 bash 循环 spawn `amp` / `claude` CLI 子进程；本插件改为通过 DSH 的 `ctx.subagents.start()` 启动**进程内一次性子 agent**，语义完全等价，但不再需要外部 CLI、`jq` 或 `--dangerously-skip-permissions`。

---

## 与原版的对应关系

| 原版 ralph.sh | dsh-ralph 插件 |
|---|---|
| `amp` / `claude` CLI 子进程 | `ctx.subagents.start(provider, request)` 派生的全新子 agent |
| 每轮全新进程 + 干净上下文 | 每轮一次性子 agent（`inheritsParentContext = false`） |
| `prompt.md` / `CLAUDE.md` 作为迭代输入 | 内置 [`prompts/ralph-iteration.md`](prompts/ralph-iteration.md)，可用 `promptFile` 覆盖 |
| `grep '<promise>COMPLETE</promise>'` | 解析子 agent 输出文本中的同一标记 |
| `jq` 读 `prd.json` 的 `branchName` | Node 内置 `fs` 读同一个 `prd.json` |
| `archive/<日期>-<分支>/` 归档 | 同样的归档目录布局，由 `progress.js` 实现 |
| `progress.txt` 初始化与重置 | 同上 |
| `.last-branch` 记录 | 同上 |
| `./ralph.sh 10` / `--tool` | `/ralph 10` 命令、`ralph` 工具、或 `maxIterations` 配置 |
| `MAX_ITERATIONS=10` | 默认 10（可用配置覆盖） |

---

## 与官方 `dsh-tool-ralph` 的区别

DSH 自带一个官方 `ralph` 工具（`@deepseek-ai/dsh-tool-ralph`），**默认关闭**（`disabled: true`）。两者都以「每轮一个全新子 agent」为骨架，但驱动方式不同：

| | 官方 `dsh-tool-ralph` | 本插件 `dsh-ralph` |
|---|---|---|
| 输入 | 一句 `objective` 文本 | **文件**：`prd.json` 用户故事 + `progress.txt` |
| 循环执行者 | 沙箱 workflow 脚本（`agent()`） | 宿主侧 JS 循环（`ctx.subagents.start`） |
| 完成判定 | 子 agent 返回结构化 `status: 'complete'` | `<promise>COMPLETE</promise>` 标记 **或** `prd.json` 全部 `passes: true` |
| 进度持久化 | 脚本内 handoff | `prd.json` + `progress.txt` + `archive/` |
| git 集成 | 无 | 每轮按 PRD `branchName` 提交、分支切换自动归档 |
| 适用场景 | 「把这个目标做完」 | 「把这份已拆解的需求清单逐条做完」 |

两者不冲突：本插件注册工具前会探测同名工具，若已被占用会自动改用 `ralph_prd`，不会导致加载失败。

---

## 安装

不安装也能用：把本目录当作普通 DSH bundle 手工挂载即可。推荐用插件的**绝对路径**安装。

### 方式 A：GUI 插件管理器（推荐）

1. **完全退出** DeepSeek Harness Desktop。
2. 重新打开，进入侧边栏 **Plugins** 页面。
3. 用「安装 bundle」填入本目录的绝对路径：`/Users/mjy/aaa/dsh-ralph`。
4. 安装完成后启用 `dsh-ralph`。

DSH 的插件管理器会自行完成 pnpm 安装、写入 `dsh.profile.bundles` 与启用行，无需手工改 profile 文件。

### 方式 B：命令行（脚本自动化）

> ⚠️ `desktop` profile 由 Electron 独占，**必须完全退出 Desktop 后**才能安装。

```bash
# 1. 退出 DeepSeek Harness Desktop
# 2. 执行安装脚本（会自动备份 profile 清单）
node scripts/install.mjs --profile desktop
# 3. 重新打开 Desktop，在 Plugins 页面确认 dsh-ralph 已启用
```

脚本做的事：备份 `package.json` / `cordis.patch.yml` → 在 profile 目录执行 pnpm 安装 → 把 `dsh-ralph` 写入 `dsh.profile.bundles`。加 `--dry-run` 只打印将要执行的步骤。

### 方式 C：手工

```bash
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 加入 "dsh-ralph": "file:/Users/mjy/aaa/dsh-ralph"
# package.json 的 dsh.profile.bundles 数组加入 "dsh-ralph"
pnpm install
```

---

## 随包技能

插件会**自己注册**两个技能到 `ctx.skills`，安装插件即生效，无需手工拷贝或额外配置：

| 技能 | 作用 |
|---|---|
| `ralph` | 把已有 PRD 转成 `prd.json`（可逐条执行的用户故事列表） |
| `prd` | 生成需求文档 `tasks/prd-<feature>.md` |

为什么要插件自己注册：DSH **不会**自动加载插件包内的 `skills/` 目录。本地技能由 `dsh-skill-filesystem` 从项目/用户技能根目录发现，并且刻意不支持嵌套的 `**​/SKILL.md`；官方包 `dsh-agent-preset` 虽然带了 `skills/` 目录，其 `lib/index.js` 里也没有任何加载逻辑，那些文件永远不会生效。因此官方 `dsh-skill` 提供了两个入口由插件主动贡献：`ctx.skills.register()`（本插件采用）与 `ctx.skills.registerProvider()`。

注册为 **runtime skill**，优先级是：**项目技能（`.dsh/skills`）> 插件技能 > 用户技能（`~/.dsh/skills`）**——项目内的同名技能可以覆盖它。

不想要自带技能时，把 `bundleSkills` 设为 `false`。

---

## 使用

### 1. 准备 PRD

两种入口，按需要选：

- 让 agent 用 **prd** skill 写一份需求文档 `tasks/prd-<feature>.md`；
- 让 agent 用 **ralph** skill 把它转成工作目录根部的 `prd.json`。

`prd.json` 的最小结构（完整示例见 [`prd.json.example`](prd.json.example)）：

```json
{
  "project": "MyApp",
  "branchName": "ralph/task-priority",
  "description": "为任务增加优先级",
  "userStories": [
    {
      "id": "US-001",
      "title": "给 tasks 表加 priority 字段",
      "description": "作为开发者，我需要持久化任务优先级。",
      "acceptanceCriteria": ["新增 priority 列", "迁移可执行", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

优先级语义：`priority` **数值越小越优先**；缺失优先级的排最后。

### 2. 启动循环

```
/ralph          # 用配置的 maxIterations（默认 10）
/ralph 5        # 本轮最多 5 次迭代
/ralph status   # 只看进度，不启动
```

或者让 agent 调用 `ralph` 工具（支持 `maxIterations` 与 `dryRun` 参数）。

### 3. 观察与终止

每轮结束都会记录一条日志与一条迭代记录。终止状态：

| 状态 | 含义 |
|---|---|
| `complete` | 子 agent 报告完成标记，或 `prd.json` 全部 `passes: true` |
| `max-iterations` | 达到最大轮数仍有未完成故事 |
| `aborted` | 调用方取消 |
| `error` | 连续失败达 `maxConsecutiveFailures`，或子 agent 提供方不可用 |
| `precondition-failed` | 找不到 `prd.json` 或其中没有用户故事 |

---

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（`dsh-ralph/cordis.patch.yml` 定义了默认行）：

```yaml
- id: ralph
  name: dsh-ralph
  config:
    maxIterations: 5
    provider: spawn
    agentOptions:
      model: deepseek-flash
      reasoningEffort: high
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `maxIterations` | `10` | 最大迭代轮数 |
| `provider` | `spawn` | 子 agent 提供方（`spawn` = 进程内全新子 agent） |
| `prdPath` | `prd.json` | PRD 文件，相对会话工作目录 |
| `progressPath` | `progress.txt` | 进度日志，相对会话工作目录 |
| `archiveDir` | `archive` | 归档根目录 |
| `lastBranchFile` | `.last-branch` | 记录上一轮分支 |
| `archiveOnBranchChange` | `true` | 分支切换时归档上一轮 |
| `promptFile` | 内置模板 | 自定义迭代提示词路径 |
| `agentOptions` | 无 | 子 agent 模型路由覆盖：`{ provider, model, reasoningEffort }` |
| `persona` | 无 | 子 agent persona |
| `maxConsecutiveFailures` | `3` | 连续失败多少轮后放弃 |
| `storyPerIteration` | `true` | 是否在提示词中指定本轮故事 |
| `toolName` | `ralph` | 工具名；`null` 表示不注册工具 |
| `commandName` | `ralph` | 命令名；`null` 表示不注册命令 |
| `bundleSkills` | `true` | 是否把随包的 `ralph` / `prd` 技能注册到 `ctx.skills` |
| `timeoutMs` | 不设置 | 工具超时；不设置表示不受工具超时策略约束 |

---

## 工作原理

```
/ralph
  │
  ├─ 前置检查：读 prd.json（缺失/为空 → precondition-failed）
  ├─ 分支归档：branchName 变化时归档 archive/<日期>-<旧分支>/
  ├─ 写 .last-branch、初始化 progress.txt
  ├─ 全部 passes: true → 直接完成（0 轮）
  │
  └─ for 第 1..maxIterations 轮：
       ├─ 重读 prd.json（上一轮的子 agent 会更新它）
       ├─ 取 priority 最小的 passes:false 故事
       ├─ 渲染提示词 → ctx.subagents.start('spawn', { label, prompt, parent, signal })
       ├─ await run.result → 提取 ContentBlock 文本 → 务必 run.dispose()
       ├─ 输出含 <promise>COMPLETE</promise> 或 PRD 全通过 → complete
       ├─ stopReason 异常 → 计数，达上限则 error（模型侧失败可重试）
       └─ 提供方启动失败 → 立即 error（基础设施问题重试无意义）
```

设计上有意的取舍：

- **不 import 任何 `@deepseek-ai/dsh-*` 内部包**。内部包未以匹配版本发布到公共 npm，硬依赖会造成版本地狱；插件只通过注入的 Cordis 服务工作（`tools` / `subagents` / `commands`）。
- **`Config` 与 `normalizeConfig()` 双层处理**。`Config`（schemastery）给 loader 校验与自动设置页；`normalizeConfig()` 再兜底一次，保证配置缺项或类型异常也不会让插件加载失败。
- **同一工作目录互斥**。同一工作目录已有循环在跑时，第二次触发会被拒绝，避免两个 Ralph 互相覆盖 `prd.json`。

---

## 目录结构

```
dsh-ralph/
├── package.json              # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml          # bundle 注册行（含全部可选配置注释）
├── lib/
│   ├── index.js              # 插件入口：name / inject / Config / apply
│   ├── config-schema.js      # schemastery 配置 schema
│   ├── config.js             # 配置默认值与归一化
│   ├── loop.js               # 循环核心（可独立测试）
│   ├── prd.js                # prd.json 解析、统计、优先级挑选
│   ├── progress.js           # progress.txt 维护与归档
│   ├── prompt.js             # 提示词模板加载与渲染
│   ├── skills.js             # 随包技能加载与 frontmatter 解析
│   └── constants.js
├── prompts/
│   └── ralph-iteration.md    # 迭代提示词（由原 prompt.md/CLAUDE.md 改造）
├── skills/
│   ├── ralph/SKILL.md        # PRD → prd.json 转换器（插件启动时自动注册）
│   └── prd/SKILL.md          # 需求文档生成器（插件启动时自动注册）
├── scripts/
│   ├── install.mjs           # 安装到 profile
│   └── verify-load.mjs       # 用真实 Cordis 验证装载（含技能注册断言）
├── test/                     # 74 项单元测试
├── flowchart/                # 原仓库的 React Flow 交互说明图（保留）
└── prd.json.example
```

---

## 开发

```bash
npm install          # 只为测试安装 @deepseek-ai/{cordis,schemastery}
npm test             # 74 项单元测试（node:test，无第三方测试框架）
node scripts/verify-load.mjs   # 用真实 Cordis 装载插件（含技能注册断言）
```

测试全部基于纯逻辑与假服务，不需要启动 DSH：

- [`prd.test.js`](test/prd.test.js) —— PRD 解析、优先级挑选、配置归一化
- [`progress.test.js`](test/progress.test.js) —— 归档、进度文件、模板渲染
- [`loop.test.js`](test/loop.test.js) —— 完成检测、PRD 回读、失败重试、取消、资源释放
- [`plugin.test.js`](test/plugin.test.js) —— 注册行为（工具/命令/技能）、冲突回退、并发保护、命令解析
- [`skills.test.js`](test/skills.test.js) —— frontmatter 解析、布尔语义、随包技能组装
- [`config-schema.test.js`](test/config-schema.test.js) —— schemastery schema 与 `null` 语义回归

---

## 已知限制

- **子 agent 不会弹出审批**：DSH 的委派子 agent 在启动时固定权限，需要审批的操作会被自动拒绝。请确保会话 preset 为 `danger-full-access`，否则写文件与 git 提交会在子 agent 内失败。
- **子 agent 默认不可再委派**：`maxDepth` 默认为 1，Ralph 每轮都是直接子 agent，不受影响。
- **命令入口无法中途取消**：DSH 的命令 handler 不接收取消信号，`/ralph` 一旦启动需等其结束；工具入口会透传 `exec.signal`。
- **同一目录串行**：同一工作目录不允许并发运行多个 Ralph 循环。

---

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。

- 原始 Ralph 实现：[snarktank/ralph](https://github.com/snarktank/ralph)，MIT
- Ralph 模式：[Geoffrey Huntley](https://ghuntley.com/ralph/)
- 插件框架：[Cordis](https://github.com/shigma/cordis) / DeepSeek Harness
