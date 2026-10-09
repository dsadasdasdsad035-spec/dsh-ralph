/**
 * Ralph 循环核心。
 *
 * 与原版 ralph.sh 的对应关系：
 *  - `amp --dangerously-allow-all < prompt.md`  →  `ctx.subagents.start(provider, ...)`
 *    （进程内一次性子 agent，每一轮都是干净上下文，等价于"全新 AI 实例"）
 *  - `grep '<promise>COMPLETE</promise>'`       →  `text.includes(COMPLETE_MARKER)`
 *  - `for i in $(seq 1 $MAX_ITERATIONS)`        →  本模块的迭代循环
 *  - progress.txt / archive / .last-branch      →  progress.js
 *
 * 本模块不依赖任何 DSH 内部包，所需能力通过参数注入，因此可独立测试。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPLETE_MARKER,
  LOOP_STATUS,
  STOP_REASON_ABORTED,
  STOP_REASON_COMPLETED,
} from './constants.js'
import { archivePreviousRun, ensureProgressFile, writeLastBranch } from './progress.js'
import { describePrd, readPrd, summarizePrd } from './prd.js'
import { loadTemplate, renderIterationPrompt } from './prompt.js'

/**
 * 从子 agent 的输出块数组中提取纯文本。
 *
 * @param {unknown} output - 子 agent 结果中的 output 字段。
 * @returns {string} 拼接后的文本。
 */
export function extractOutputText(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 截取用于日志的文本摘要。
 *
 * @param {string} text - 原始文本。
 * @param {number} [limit] - 最大长度。
 * @returns {string} 单行摘要。
 */
export function excerpt(text, limit = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 结算一次子 agent 运行：先取结果，再释放资源，且不让释放异常覆盖结果异常。
 *
 * @param {object} run - `ctx.subagents.start()` 返回的运行句柄。
 * @param {(message: string) => void} [warn] - 释放失败时的告警回调。
 * @returns {Promise<object>} 子 agent 的终态结果。
 */
async function settleRun(run, warn) {
  let result
  let resultError
  try {
    result = await run.result
  } catch (error) {
    resultError = error
  }
  try {
    await run.dispose()
  } catch (error) {
    warn?.(`释放子 agent 运行失败：${String(error)}`)
    if (resultError === undefined) resultError = error
  }
  if (resultError !== undefined) throw resultError
  return result
}

/**
 * 运行 Ralph 循环。
 *
 * @param {object} options - 循环参数。
 * @param {object} options.subagents - `ctx.subagents` 服务。
 * @param {object} options.parent - 作为父级的 Agent 实例（来自 `exec.agent` 或命令的 `agent`）。
 * @param {object} options.config - 归一化后的插件配置。
 * @param {string} options.workspaceRoot - 会话工作目录。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {(level: string, message: string) => void} [options.log] - 日志回调。
 * @param {Date} [options.now] - 可注入的时间，便于测试。
 * @returns {Promise<object>} 循环结果。
 */
export async function runRalphLoop(options) {
  const { subagents, parent, config, workspaceRoot } = options
  const signal = options.signal
  const log = options.log ?? (() => {})
  const now = options.now ?? new Date()

  const prdFile = join(workspaceRoot, config.prdPath)
  const progressFile = join(workspaceRoot, config.progressPath)
  const archiveRoot = join(workspaceRoot, config.archiveDir)
  const lastBranchFile = join(workspaceRoot, config.lastBranchFile)

  /** 每轮结果的历史记录。 */
  const history = []

  // ---- 前置检查：PRD 必须存在且包含用户故事 ----
  let loaded = readPrd(prdFile)
  if (!loaded.ok) {
    return {
      status: LOOP_STATUS.PRECONDITION_FAILED,
      iterations: 0,
      history,
      message: loaded.error,
    }
  }
  let prd = loaded.prd
  if (!Array.isArray(prd.userStories) || prd.userStories.length === 0) {
    return {
      status: LOOP_STATUS.PRECONDITION_FAILED,
      iterations: 0,
      history,
      message: `PRD 中没有任何用户故事：${prdFile}`,
    }
  }

  // ---- 分支切换时归档上一轮运行（原版 ralph.sh 行为） ----
  const branchName = typeof prd.branchName === 'string' ? prd.branchName : ''
  if (config.archiveOnBranchChange) {
    const archived = archivePreviousRun({
      archiveRoot,
      branchName,
      prdFile,
      progressFile,
      lastBranchFile,
      now,
    })
    if (archived.archived) {
      log('info', `已归档上一轮运行（分支 ${archived.branch}）到 ${archived.folder}`)
    }
  }
  if (branchName) writeLastBranch(lastBranchFile, branchName)
  const created = ensureProgressFile(progressFile, { now })
  if (created) log('info', `已初始化进度日志：${progressFile}`)

  // ---- 已经全部完成则直接返回 ----
  let summary = summarizePrd(prd)
  if (summary.allPassed) {
    return {
      status: LOOP_STATUS.COMPLETE,
      iterations: 0,
      history,
      summary,
      prd,
      message: `${describePrd(prd)} —— 无需运行`,
    }
  }

  const template = loadTemplate(config.promptFile)
  const maxIterations = config.maxIterations
  let consecutiveFailures = 0
  let lastError = ''

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (signal?.aborted === true) {
      return {
        status: LOOP_STATUS.ABORTED,
        iterations: iteration - 1,
        history,
        summary,
        prd,
        message: `已被取消（完成 ${iteration - 1} 轮）`,
      }
    }

    // 每轮重新读取 PRD：上一轮的子 agent 会更新 passes 字段。
    loaded = readPrd(prdFile)
    if (loaded.ok) {
      prd = loaded.prd
      summary = summarizePrd(prd)
      if (summary.allPassed) {
        return {
          status: LOOP_STATUS.COMPLETE,
          iterations: iteration - 1,
          history,
          summary,
          prd,
          message: `${describePrd(prd)} —— 子 agent 已更新 PRD`,
        }
      }
    }

    const story = config.storyPerIteration ? summary.next : undefined
    const prompt = renderIterationPrompt({
      template,
      workspaceRoot,
      prdPath: config.prdPath,
      progressPath: config.progressPath,
      iteration,
      maxIterations,
      story,
    })
    const label = story?.id !== undefined
      ? `ralph #${iteration} ${story.id}`
      : `ralph #${iteration}`
    const startedAt = Date.now()

    let run
    try {
      run = await subagents.start(config.provider, {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        ...(signal !== undefined ? { signal } : {}),
        ...(config.agentOptions !== null ? { agentOptions: config.agentOptions } : {}),
        ...(config.persona !== null ? { persona: config.persona } : {}),
      })
    } catch (error) {
      // 基础设施级错误（提供方缺失、能力不支持等）：重试没有意义，立即终止。
      const message = `启动第 ${iteration} 轮子 agent 失败：${String(error)}`
      log('error', message)
      history.push({
        iteration,
        storyId: story?.id ?? null,
        stopReason: null,
        completed: false,
        infrastructureFailure: true,
        durationMs: Date.now() - startedAt,
        excerpt: '',
      })
      return {
        status: LOOP_STATUS.ERROR,
        iterations: iteration,
        history,
        summary,
        prd,
        message,
      }
    }

    let result
    let failure
    try {
      result = await settleRun(run, (message) => log('warn', message))
    } catch (error) {
      failure = error
    }

    const durationMs = Date.now() - startedAt
    if (failure !== undefined) {
      lastError = String(failure)
      consecutiveFailures += 1
      log('warn', `第 ${iteration} 轮失败：${excerpt(lastError, 300)}`)
      history.push({
        iteration,
        storyId: story?.id ?? null,
        stopReason: null,
        completed: false,
        infrastructureFailure: false,
        durationMs,
        excerpt: excerpt(lastError),
      })
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        return {
          status: LOOP_STATUS.ERROR,
          iterations: iteration,
          history,
          summary,
          prd,
          message: `连续 ${consecutiveFailures} 轮失败，已停止。最后一次错误：${excerpt(lastError, 300)}`,
        }
      }
      continue
    }

    const stopReason = result?.stopReason
    const text = extractOutputText(result?.output)

    if (stopReason === STOP_REASON_ABORTED) {
      history.push({
        iteration,
        storyId: story?.id ?? null,
        stopReason,
        completed: false,
        infrastructureFailure: false,
        durationMs,
        excerpt: excerpt(text),
      })
      return {
        status: LOOP_STATUS.ABORTED,
        iterations: iteration,
        history,
        summary,
        prd,
        message: `第 ${iteration} 轮被取消`,
      }
    }

    if (stopReason !== STOP_REASON_COMPLETED) {
      // 模型侧失败（token 上限、拒绝、运行错误）：换一轮重试是有意义的。
      consecutiveFailures += 1
      const reason = `第 ${iteration} 轮异常结束（stopReason=${String(stopReason)}）`
      log('warn', reason)
      history.push({
        iteration,
        storyId: story?.id ?? null,
        stopReason,
        completed: false,
        infrastructureFailure: false,
        durationMs,
        excerpt: excerpt(text),
      })
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        return {
          status: LOOP_STATUS.ERROR,
          iterations: iteration,
          history,
          summary,
          prd,
          message: `连续 ${consecutiveFailures} 轮异常结束，已停止。最后一轮：${reason}`,
        }
      }
      continue
    }

    consecutiveFailures = 0

    // 重新读取 PRD，拿到子 agent 更新后的进度。
    loaded = readPrd(prdFile)
    if (loaded.ok) {
      prd = loaded.prd
      summary = summarizePrd(prd)
    }

    const completed = text.includes(COMPLETE_MARKER)
    history.push({
      iteration,
      storyId: story?.id ?? null,
      stopReason,
      completed,
      infrastructureFailure: false,
      durationMs,
      excerpt: excerpt(text),
    })
    log('info', `第 ${iteration} 轮结束：${summary.passed}/${summary.total} 完成`)

    if (completed || summary.allPassed) {
      return {
        status: LOOP_STATUS.COMPLETE,
        iterations: iteration,
        history,
        summary,
        prd,
        message: completed
          ? `第 ${iteration} 轮返回完成标记：${describePrd(prd)}`
          : `第 ${iteration} 轮后 PRD 全部通过：${describePrd(prd)}`,
      }
    }
  }

  return {
    status: LOOP_STATUS.MAX_ITERATIONS,
    iterations: maxIterations,
    history,
    summary,
    prd,
    message: `达到最大迭代轮数 ${maxIterations} 仍未完成。${describePrd(prd)}`,
  }
}

/**
 * 判断工作目录中是否存在可运行的 Ralph 工程（存在 prd.json）。
 *
 * @param {string} workspaceRoot - 会话工作目录。
 * @param {string} prdPath - PRD 相对路径。
 * @returns {boolean} 是否存在。
 */
export function hasPrd(workspaceRoot, prdPath) {
  return existsSync(join(workspaceRoot, prdPath))
}
