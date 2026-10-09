/**
 * loop.js 的单元测试。
 *
 * 用假的 `ctx.subagents` 服务驱动真实循环逻辑：验证完成标记检测、PRD 回读、
 * 失败重试、基础设施错误早停、取消、归档与资源释放。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOOP_STATUS, COMPLETE_MARKER } from '../lib/constants.js'
import { normalizeConfig } from '../lib/config.js'
import { runRalphLoop, extractOutputText, excerpt } from '../lib/loop.js'
import { readPrd, writePrd } from '../lib/prd.js'
import { writeLastBranch } from '../lib/progress.js'

/** 一个固定的 PRD，含两个待办故事。 */
function pendingPrd() {
  return {
    project: 'MyApp',
    branchName: 'ralph/demo',
    userStories: [
      { id: 'US-001', title: '第一件', priority: 1, passes: false },
      { id: 'US-002', title: '第二件', priority: 2, passes: false },
    ],
  }
}

/**
 * 构造假的 subagents 服务。
 *
 * @param {(context: {index: number, request: object}) => object | Promise<object>} handler - 每轮的结果生产者。
 * @returns {object} 假服务与其调用记录。
 */
function makeSubagents(handler) {
  const calls = []
  const runs = []
  return {
    calls,
    runs,
    async start(provider, request) {
      const index = calls.length
      calls.push({ provider, request })
      const run = {
        id: `run-${index + 1}`,
        disposed: false,
        result: Promise.resolve().then(() => handler({ index, request })),
        async dispose() {
          run.disposed = true
        },
      }
      runs.push(run)
      return run
    },
  }
}

/** 构造运行参数。 */
function makeOptions(dir, subagents, overrides = {}) {
  return {
    subagents,
    parent: { id: 'parent-agent' },
    config: normalizeConfig({ maxIterations: 3, ...(overrides.config ?? {}) }),
    workspaceRoot: dir,
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
    ...(overrides.log !== undefined ? { log: overrides.log } : {}),
  }
}

/** 建一个已写入 PRD 的临时目录。 */
function dirWithPrd(prd = pendingPrd()) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-loop-'))
  writePrd(join(dir, 'prd.json'), prd)
  return dir
}

test('extractOutputText 只拼接 text 块', () => {
  const text = extractOutputText([
    { type: 'text', text: '甲' },
    { type: 'image', data: 'x' },
    { type: 'text', text: '乙' },
    null,
    'raw',
  ])
  assert.equal(text, '甲乙')
  assert.equal(extractOutputText(undefined), '')
  assert.equal(extractOutputText('not-array'), '')
})

test('excerpt 压平空白并截断', () => {
  assert.equal(excerpt('a\n\n b   c'), 'a b c')
  assert.equal(excerpt('x'.repeat(300), 10), `${'x'.repeat(10)}…`)
})

test('PRD 缺失时返回前置条件失败且不启动子 agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-loop-'))
  const subagents = makeSubagents(() => ({ stopReason: 'completed', output: [] }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.PRECONDITION_FAILED)
  assert.equal(subagents.calls.length, 0)
  assert.match(outcome.message, /未找到 PRD 文件/)
})

test('userStories 为空时返回前置条件失败', async () => {
  const dir = dirWithPrd({ project: 'X', userStories: [] })
  const subagents = makeSubagents(() => ({ stopReason: 'completed', output: [] }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.PRECONDITION_FAILED)
  assert.equal(subagents.calls.length, 0)
})

test('全部故事已完成时直接返回完成，零轮迭代', async () => {
  const dir = dirWithPrd({ project: 'X', userStories: [{ id: 'A', priority: 1, passes: true }] })
  const subagents = makeSubagents(() => ({ stopReason: 'completed', output: [] }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  assert.equal(outcome.iterations, 0)
  assert.equal(subagents.calls.length, 0)
})

test('子 agent 返回完成标记时结束循环并释放运行', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: `全部完成 ${COMPLETE_MARKER}` }],
  }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  assert.equal(outcome.iterations, 1)
  assert.equal(subagents.calls.length, 1)
  assert.equal(subagents.runs[0].disposed, true)
  assert.equal(outcome.history[0].completed, true)
})

test('提示词包含轮次、PRD 路径与本轮指定故事，且以父 agent 为 parent', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: COMPLETE_MARKER }],
  }))
  await runRalphLoop(makeOptions(dir, subagents))
  const call = subagents.calls[0]
  assert.equal(call.provider, 'spawn')
  assert.equal(call.request.parent.id, 'parent-agent')
  assert.equal(call.request.label, 'ralph #1 US-001')
  const prompt = call.request.prompt[0].text
  assert.match(prompt, /第 1 \/ 3 轮/)
  assert.match(prompt, /prd\.json/)
  assert.match(prompt, /US-001 第一件/)
})

test('子 agent 更新 PRD 使全部通过后，即使没有标记也判定完成', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(({ index }) => {
    if (index === 0) {
      const loaded = readPrd(join(dir, 'prd.json'))
      const prd = loaded.prd
      for (const story of prd.userStories) story.passes = true
      writePrd(join(dir, 'prd.json'), prd)
    }
    return { stopReason: 'completed', output: [{ type: 'text', text: '本轮完成' }] }
  })
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  assert.equal(outcome.iterations, 1)
  assert.equal(outcome.summary.allPassed, true)
})

test('达到最大轮数仍未完成时返回 max-iterations 并保持轮数', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: '做了点事，但还没完成' }],
  }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { config: { maxIterations: 3 } }))
  assert.equal(outcome.status, LOOP_STATUS.MAX_ITERATIONS)
  assert.equal(outcome.iterations, 3)
  assert.equal(subagents.calls.length, 3)
  assert.equal(subagents.runs.every((run) => run.disposed), true)
})

test('每轮读取最新 PRD，故事逐轮推进', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(({ index }) => {
    const loaded = readPrd(join(dir, 'prd.json'))
    const prd = loaded.prd
    const target = prd.userStories.find((story) => story.passes !== true)
    if (target !== undefined) target.passes = true
    writePrd(join(dir, 'prd.json'), prd)
    return { stopReason: 'completed', output: [{ type: 'text', text: `完成第 ${index + 1} 件` }] }
  })
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { config: { maxIterations: 5 } }))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  assert.equal(subagents.calls.length, 2)
  assert.equal(subagents.calls[0].request.label, 'ralph #1 US-001')
  assert.equal(subagents.calls[1].request.label, 'ralph #2 US-002')
})

test('模型侧连续异常结束达到上限后报错停止', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({ stopReason: 'max-tokens', output: [{ type: 'text', text: '被截断' }] }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { config: { maxIterations: 10, maxConsecutiveFailures: 2 } }))
  assert.equal(outcome.status, LOOP_STATUS.ERROR)
  assert.equal(subagents.calls.length, 2)
  assert.match(outcome.message, /连续 2 轮异常结束/)
})

test('模型侧失败后成功可以重置连续失败计数', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(({ index }) => {
    if (index === 0) return { stopReason: 'error', output: [] }
    return { stopReason: 'completed', output: [{ type: 'text', text: COMPLETE_MARKER }] }
  })
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { config: { maxIterations: 5, maxConsecutiveFailures: 2 } }))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  assert.equal(subagents.calls.length, 2)
})

test('启动子 agent 失败属于基础设施错误，立即终止', async () => {
  const dir = dirWithPrd()
  const subagents = {
    calls: [],
    async start() {
      this.calls.push({})
      throw new Error('提供方 "spawn" 未注册')
    },
  }
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.ERROR)
  assert.equal(outcome.iterations, 1)
  assert.equal(outcome.history[0].infrastructureFailure, true)
  assert.match(outcome.message, /启动第 1 轮子 agent 失败/)
})

test('结果 promise 拒绝时被记为单轮失败而非崩溃', async () => {
  const dir = dirWithPrd()
  let disposed = false
  const subagents = {
    calls: [],
    async start() {
      this.calls.push({})
      return {
        id: 'run-1',
        result: Promise.reject(new Error('子 agent 崩溃')),
        async dispose() {
          disposed = true
        },
      }
    },
  }
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { config: { maxConsecutiveFailures: 1 } }))
  assert.equal(outcome.status, LOOP_STATUS.ERROR)
  assert.equal(disposed, true)
  assert.match(outcome.message, /子 agent 崩溃/)
})

test('预先取消的信号使循环以 aborted 结束且不启动子 agent', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({ stopReason: 'completed', output: [] }))
  const controller = new AbortController()
  controller.abort()
  const outcome = await runRalphLoop(makeOptions(dir, subagents, { signal: controller.signal }))
  assert.equal(outcome.status, LOOP_STATUS.ABORTED)
  assert.equal(subagents.calls.length, 0)
})

test('子 agent 报告 aborted 时立即结束循环', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({ stopReason: 'aborted', output: [] }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(outcome.status, LOOP_STATUS.ABORTED)
  assert.equal(subagents.calls.length, 1)
})

test('分支变化时归档上一轮运行并写入新的分支记录', async () => {
  const dir = dirWithPrd({ ...pendingPrd(), branchName: 'ralph/new' })
  writeLastBranch(join(dir, '.last-branch'), 'ralph/old')
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: COMPLETE_MARKER }],
  }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents, {
    config: { archiveOnBranchChange: true },
  }))
  assert.equal(outcome.status, LOOP_STATUS.COMPLETE)
  const archiveDir = join(dir, 'archive')
  assert.equal(existsSync(archiveDir), true)
  assert.equal(existsSync(join(dir, '.last-branch')), true)
})

test('进度日志在缺失时被初始化', async () => {
  const dir = dirWithPrd()
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: COMPLETE_MARKER }],
  }))
  await runRalphLoop(makeOptions(dir, subagents))
  assert.equal(existsSync(join(dir, 'progress.txt')), true)
})

test('每轮事件都记录进 history', async () => {
  const dir = dirWithPrd()
  const messages = []
  const subagents = makeSubagents(() => ({
    stopReason: 'completed',
    output: [{ type: 'text', text: '继续' }],
  }))
  const outcome = await runRalphLoop(makeOptions(dir, subagents, {
    config: { maxIterations: 2 },
    log: (level, message) => messages.push(`${level}:${message}`),
  }))
  assert.equal(outcome.history.length, 2)
  assert.equal(outcome.history[0].iteration, 1)
  assert.equal(outcome.history[0].stopReason, 'completed')
  assert.equal(typeof outcome.history[0].durationMs, 'number')
  assert.ok(messages.some((entry) => entry.startsWith('info:第 1 轮结束')))
})
