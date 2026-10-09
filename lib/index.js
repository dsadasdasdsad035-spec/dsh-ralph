/**
 * dsh-ralph —— DeepSeek Harness 插件入口。
 *
 * 把原版 Ralph（https://github.com/snarktank/ralph）的「反复启动全新 AI 实例，
 * 直到 PRD 中所有用户故事完成」循环，改造成 DSH 原生插件：
 *
 *  - 原版每轮 spawn 一个 `amp` / `claude` CLI 子进程；
 *    本插件每轮通过 `ctx.subagents.start()` 启动一个进程内一次性子 agent。
 *    两者语义一致：全新实例、干净上下文，记忆靠 git 历史 + prd.json + progress.txt。
 *  - 原版用 shell 循环 + grep 检测 `<promise>COMPLETE</promise>`；
 *    本插件用同样的标记做终止判断，并额外维护归档与进度统计。
 *
 * 设计约束：本插件**不 import 任何 @deepseek-ai/dsh-* 内部包**，只通过注入的
 * Cordis 服务工作。原因是 DSH 内部包（dsh-tools、dsh-subagent 等）尚未以匹配
 * 版本发布到公共 npm，硬依赖会造成版本地狱；服务接口才是稳定的公开面。
 */

import { join } from 'node:path'

import { LOOP_STATUS, PLUGIN_ID } from './constants.js'
import { Config } from './config-schema.js'
import { normalizeConfig } from './config.js'
import { runRalphLoop } from './loop.js'
import { describePrd, readPrd, summarizePrd } from './prd.js'

/**
 * 配置 schema（schemastery）。loader 用它校验 profile patch 行里的 `config`，
 * 并据此生成设置页；`apply()` 内仍会经 `normalizeConfig()` 再兜底一次。
 */
export { Config }

/** 正在运行的工作目录集合，用于防止同一项目并发触发多次循环。 */
const runningWorkspaces = new Set()

/**
 * 构造一个健壮的日志函数。
 *
 * Cordis 的 logger 既可能直接提供 `info/warn/error` 方法，也可能需要先调用
 * 一次以取得带前缀的子 logger，这里统一兼容，并且日志失败绝不影响主流程。
 *
 * @param {object} ctx - 插件上下文。
 * @returns {(level: 'info'|'warn'|'error', message: string) => void} 日志函数。
 */
function createLog(ctx) {
  return (level, message) => {
    try {
      const base = ctx.logger
      if (base === undefined || base === null) return
      const scoped = typeof base === 'function' ? base(PLUGIN_ID) : base
      const method = typeof scoped?.[level] === 'function' ? scoped[level] : scoped?.info
      if (typeof method === 'function') method.call(scoped, message)
    } catch {
      // 日志失败被刻意忽略：它不应影响循环本身。
    }
  }
}

/**
 * 取得调用方的工作目录。
 *
 * @param {object | undefined} agent - 发起调用的 agent。
 * @returns {string} 会话工作目录，缺失时退回宿主进程的工作目录。
 */
function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/**
 * 解析命令输入。
 *
 * 支持的形式：
 *  - `/ralph`         → 使用配置的 maxIterations
 *  - `/ralph 5`       → 本轮最多 5 次迭代
 *  - `/ralph status`  → 只显示进度，不启动循环
 *
 * @param {string} rawInput - 命令后的原始输入。
 * @param {number} fallback - 默认最大迭代轮数。
 * @returns {{ mode: 'run'|'status', maxIterations: number }} 解析结果。
 */
export function parseCommandInput(rawInput, fallback) {
  const text = String(rawInput ?? '').trim()
  if (text === 'status' || text === '--status') return { mode: 'status', maxIterations: fallback }
  const match = text.match(/\d+/)
  if (match !== null) {
    const value = Number.parseInt(match[0], 10)
    if (Number.isFinite(value) && value > 0) return { mode: 'run', maxIterations: value }
  }
  return { mode: 'run', maxIterations: fallback }
}

/**
 * 把循环结果渲染成面向用户/模型的文本。
 *
 * @param {object} outcome - `runRalphLoop()` 的返回值。
 * @returns {string} 多行文本。
 */
export function renderOutcome(outcome) {
  const lines = []
  switch (outcome.status) {
    case LOOP_STATUS.COMPLETE:
      lines.push('✅ Ralph 已完成全部用户故事。')
      break
    case LOOP_STATUS.MAX_ITERATIONS:
      lines.push('⚠️ Ralph 达到最大迭代轮数，仍有未完成的故事。')
      break
    case LOOP_STATUS.ABORTED:
      lines.push('⏹️ Ralph 已被取消。')
      break
    case LOOP_STATUS.ERROR:
      lines.push('❌ Ralph 因连续失败而停止。')
      break
    case LOOP_STATUS.PRECONDITION_FAILED:
      lines.push('❌ Ralph 无法启动。')
      break
    default:
      lines.push(`ℹ️ Ralph 结束（${outcome.status}）。`)
  }
  lines.push(outcome.message)
  if (outcome.history !== undefined && outcome.history.length > 0) {
    lines.push('')
    lines.push(`迭代记录（共 ${outcome.history.length} 轮）：`)
    for (const entry of outcome.history) {
      const story = entry.storyId ?? '—'
      const status = entry.completed ? '完成' : entry.stopReason ?? (entry.infrastructureFailure ? '启动失败' : '异常')
      lines.push(`  #${entry.iteration} ${story} · ${status} · ${Math.round(entry.durationMs / 1000)}s`)
    }
  }
  return lines.join('\n')
}

/**
 * Cordis 插件名。
 */
export const name = PLUGIN_ID

/**
 * 依赖的 Cordis 服务：注册工具需要 `tools`，启动子 agent 需要 `subagents`。
 */
export const inject = ['tools', 'subagents']

/**
 * 插件主体。
 *
 * @param {object} ctx - 插件上下文。
 * @param {unknown} rawConfig - 来自 profile 的配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = createLog(ctx)

  /**
   * 执行一次 Ralph 循环（工具与命令共用）。
   *
   * @param {object} options - 调用参数。
   * @param {object} options.agent - 父 agent。
   * @param {number} options.maxIterations - 最大轮数。
   * @param {boolean} options.dryRun - 只做前置检查与进度统计。
   * @param {AbortSignal} [options.signal] - 取消信号。
   * @returns {Promise<{ text: string, ok: boolean }>} 结果文本与成功标志。
   */
  async function executeRalph(options) {
    const { agent, maxIterations, dryRun } = options
    const workspaceRoot = workspaceOf(agent)

    if (dryRun) {
      const loaded = readPrd(join(workspaceRoot, config.prdPath))
      if (!loaded.ok) return { ok: false, text: `❌ ${loaded.error}` }
      return { ok: true, text: `📋 ${describePrd(loaded.prd)}` }
    }

    if (agent === undefined || agent === null) {
      return { ok: false, text: '❌ 无法确定父 agent（缺少 exec.agent），Ralph 需要一个父会话来派生子 agent。' }
    }
    if (runningWorkspaces.has(workspaceRoot)) {
      return { ok: false, text: `⚠️ 该工作目录已有 Ralph 循环在运行：${workspaceRoot}` }
    }

    runningWorkspaces.add(workspaceRoot)
    try {
      // `ctx.subagents.start()` 要求请求携带取消信号。工具路径有 exec.signal，
      // 命令路径没有，这里用不会被触发的控制器兜底，保证字段始终存在。
      const signal = options.signal ?? new AbortController().signal
      const outcome = await runRalphLoop({
        subagents: ctx.subagents,
        parent: agent,
        config: { ...config, maxIterations },
        workspaceRoot,
        signal,
        log,
      })
      const ok = outcome.status === LOOP_STATUS.COMPLETE
      return { ok, text: renderOutcome(outcome) }
    } catch (error) {
      log('error', `Ralph 循环异常：${String(error)}`)
      return { ok: false, text: `❌ Ralph 循环异常终止：${String(error)}` }
    } finally {
      runningWorkspaces.delete(workspaceRoot)
    }
  }

  // ---- 面向模型的工具 ----
  // 官方 @deepseek-ai/dsh-tool-ralph 默认 disabled，但用户可以自行启用；届时
  // `ralph` 这个名字会被占用，而同一层重复注册同名工具会直接抛错。这里先探测
  // 再回退到 `ralph_prd`，避免插件整体加载失败。
  let toolName = config.toolName
  if (toolName !== null && typeof ctx.tools.get === 'function' && ctx.tools.get(toolName) !== undefined) {
    const fallback = `${toolName}_prd`
    log('warn', `工具名 "${toolName}" 已被占用（可能来自官方 tool-ralph），自动改用 "${fallback}"`)
    toolName = fallback
  }
  if (toolName !== null) {
    ctx.tools.register({
      name: toolName,
      description: [
        '运行 Ralph 自主循环：反复启动全新的子 agent，每次只实现 prd.json 中一个最高优先级的用户故事，',
        '直到所有故事的 passes 均为 true 或达到最大轮数。',
        '每次迭代都是干净上下文，记忆通过 git 历史、prd.json 与 progress.txt 延续。',
        '适合让一批已拆解好的用户故事在无人干预的情况下被逐个实现。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          maxIterations: {
            type: 'number',
            description: `最大迭代轮数，默认 ${config.maxIterations}。`,
          },
          dryRun: {
            type: 'boolean',
            description: '只读取 prd.json 并报告进度，不启动任何子 agent。',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => false,
      ...(config.timeoutMs !== null ? { timeoutMs: config.timeoutMs } : {}),
      async execute(args, exec) {
        const result = await executeRalph({
          agent: exec.agent,
          maxIterations: typeof args?.maxIterations === 'number' && args.maxIterations > 0
            ? Math.floor(args.maxIterations)
            : config.maxIterations,
          dryRun: args?.dryRun === true,
          signal: exec.signal,
        })
        return result.text
      },
    })
  }

  // ---- 面向用户的斜杠命令（可选：commands 服务可能未挂载） ----
  if (config.commandName !== null) {
    ctx.inject(['commands'], (scoped) => {
      try {
        // 返回 disposer，交给 Cordis 在 fiber 销毁时自动撤销注册。
        return scoped.commands.register({
          name: config.commandName,
          description: '启动 Ralph 自主循环（每个用户故事一轮，全新上下文）',
          input: { hint: '[轮数 | status]' },
          async handler(invocation) {
            const parsed = parseCommandInput(invocation.rawInput, config.maxIterations)
            const result = await executeRalph({
              agent: invocation.agent,
              maxIterations: parsed.maxIterations,
              dryRun: parsed.mode === 'status',
            })
            return { kind: result.ok ? 'success' : 'error', text: result.text }
          },
        })
      } catch (error) {
        // 同名命令已被其他插件注册时不让插件加载失败，只停用命令入口。
        log('warn', `注册命令 /${config.commandName} 失败，已跳过：${String(error)}`)
        return undefined
      }
    })
  }

  // 启动时报告一次进度，便于确认插件已就位。
  try {
    const workspaceRoot = process.cwd()
    const loaded = readPrd(join(workspaceRoot, config.prdPath))
    if (loaded.ok) {
      const summary = summarizePrd(loaded.prd)
      log('info', `已就绪：${describePrd(loaded.prd)}`)
      if (summary.allPassed) log('info', '全部用户故事均已完成')
    } else {
      log('info', `已就绪；当前目录未找到 ${config.prdPath}，使用前请先准备 PRD`)
    }
  } catch {
    // 启动诊断失败不影响插件注册。
  }
}
