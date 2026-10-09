/**
 * index.js 的单元测试：插件注册行为、命令解析、结果渲染与并发保护。
 *
 * 这里用最小的假 ctx 复现 Cordis 提供的服务面（tools / subagents / commands /
 * logger / inject），从而在不启动 DSH 的情况下验证插件装配是否正确。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name, parseCommandInput, renderOutcome } from '../lib/index.js'
import { LOOP_STATUS, COMPLETE_MARKER } from '../lib/constants.js'
import { writePrd } from '../lib/prd.js'

/** 构造一个假 ctx，返回其记录容器。 */
function makeCtx(options = {}) {
  const tools = []
  const commands = []
  const skills = []
  const injected = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => logs.push(`warn:${message}`),
      error: (message) => logs.push(`error:${message}`),
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      get: () => options.existingTool,
    },
    subagents: options.subagents ?? { start: async () => ({}) },
    inject: (services, callback) => {
      injected.push(services)
      const scoped = {}
      if (services.includes('commands')) {
        scoped.commands = {
          register: (command) => {
            if (options.commandRegisterFails === true) throw new Error('命令已存在')
            commands.push(command)
            return () => {}
          },
        }
      }
      if (services.includes('skills')) {
        scoped.skills = {
          register: (skill) => {
            if (options.skillRegisterFails === true) throw new Error('技能已存在')
            skills.push(skill)
            return () => {}
          },
        }
      }
      callback(scoped)
      return () => {}
    },
  }
  return { ctx, tools, commands, skills, injected, logs }
}

/** 构造一个带工作目录的假 agent。 */
function agentAt(dir) {
  return { id: 'agent-1', session: { header: { cwd: dir } } }
}

test('插件导出正确的 Cordis 元信息', () => {
  assert.equal(name, 'dsh-ralph')
  assert.deepEqual(inject, ['tools', 'subagents'])
})

test('apply 注册工具与命令，并请求 commands 服务', () => {
  const { ctx, tools, commands, injected } = makeCtx()
  apply(ctx, {})

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'ralph')
  assert.equal(typeof tools[0].execute, 'function')
  // 参数采用受支持的 JSON Schema 子集（object + properties + required）
  assert.equal(tools[0].parameters.type, 'object')
  assert.equal(tools[0].parameters.properties.maxIterations.type, 'number')
  assert.equal(tools[0].parameters.properties.dryRun.type, 'boolean')
  assert.deepEqual(tools[0].parameters.required, [])
  // output 必须声明 schema + render
  assert.deepEqual(tools[0].output.schema, { type: 'string' })
  assert.deepEqual(tools[0].output.render({}, 'x'), [{ type: 'text', text: 'x' }])
  assert.equal(tools[0].isConcurrencySafe(), false)

  assert.deepEqual(injected, [['commands'], ['skills']])
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'ralph')
  assert.equal(typeof commands[0].handler, 'function')
})

test('apply 把随包技能注册到 skills 服务', () => {
  const { ctx, skills } = makeCtx()
  apply(ctx, {})
  assert.equal(skills.length, 2)
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['prd', 'ralph'])
  for (const skill of skills) {
    assert.ok(skill.description.length > 0, `${skill.name} 应有 description`)
    assert.ok(skill.content.length > 100, `${skill.name} 应有正文`)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  }
})

test('bundleSkills=false 时不注册技能', () => {
  const { ctx, skills, injected } = makeCtx()
  apply(ctx, { bundleSkills: false })
  assert.equal(skills.length, 0)
  assert.ok(!injected.some((services) => services.includes('skills')))
})

test('技能注册失败时插件仍能加载', () => {
  const { ctx, tools, logs } = makeCtx({ skillRegisterFails: true })
  apply(ctx, {})
  assert.equal(tools.length, 1)
  assert.ok(logs.some((line) => line.startsWith('warn:') && line.includes('注册技能')))
})

test('配置可禁用工具、命令与技能', () => {
  const { ctx, tools, commands, skills, injected } = makeCtx()
  apply(ctx, { toolName: null, commandName: null, bundleSkills: false })
  assert.equal(tools.length, 0)
  assert.equal(commands.length, 0)
  assert.equal(skills.length, 0)
  assert.equal(injected.length, 0)
})

test('工具名冲突时自动回退并告警', () => {
  const { ctx, tools, logs } = makeCtx({ existingTool: { name: 'ralph' } })
  apply(ctx, {})
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'ralph_prd')
  assert.ok(logs.some((line) => line.startsWith('warn:') && line.includes('已被占用')))
})

test('命令注册失败时插件仍能加载', () => {
  const { ctx, tools, logs } = makeCtx({ commandRegisterFails: true })
  apply(ctx, {})
  assert.equal(tools.length, 1)
  assert.ok(logs.some((line) => line.startsWith('warn:') && line.includes('注册命令')))
})

test('dryRun 只读取 PRD 并报告进度', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  writePrd(join(dir, 'prd.json'), {
    project: 'MyApp',
    userStories: [
      { id: 'US-001', priority: 1, passes: true },
      { id: 'US-002', priority: 2, passes: false },
    ],
  })
  const { ctx, tools } = makeCtx()
  apply(ctx, {})
  const text = await tools[0].execute({ dryRun: true }, { agent: agentAt(dir), signal: undefined })
  assert.match(text, /MyApp：1\/2 完成（50%）/)
  assert.match(text, /US-002/)
})

test('dryRun 缺少 PRD 时返回错误说明', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  const { ctx, tools } = makeCtx()
  apply(ctx, {})
  const text = await tools[0].execute({ dryRun: true }, { agent: agentAt(dir) })
  assert.match(text, /未找到 PRD 文件/)
})

test('缺少父 agent 时拒绝运行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  const { ctx, tools } = makeCtx()
  apply(ctx, {})
  const text = await tools[0].execute({}, { agent: undefined })
  assert.match(text, /无法确定父 agent/)
})

test('工具执行完整循环并把完成标记反映到结果文本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  writePrd(join(dir, 'prd.json'), {
    project: 'MyApp',
    branchName: 'ralph/demo',
    userStories: [{ id: 'US-001', title: '甲', priority: 1, passes: false }],
  })
  const calls = []
  const subagents = {
    async start(provider, request) {
      calls.push({ provider, request })
      return {
        id: 'run-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: COMPLETE_MARKER }] }),
        async dispose() {},
      }
    },
  }
  const { ctx, tools } = makeCtx({ subagents })
  apply(ctx, { maxIterations: 2 })
  const text = await tools[0].execute({}, { agent: agentAt(dir), signal: new AbortController().signal })
  assert.match(text, /Ralph 已完成全部用户故事/)
  assert.equal(calls.length, 1)
  // 请求必须带 signal 与 parent
  assert.equal(calls[0].provider, 'spawn')
  assert.equal(calls[0].request.parent.id, 'agent-1')
  assert.ok(calls[0].request.signal !== undefined)
})

test('同一工作目录并发触发被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  writePrd(join(dir, 'prd.json'), {
    project: 'MyApp',
    branchName: 'ralph/demo',
    userStories: [{ id: 'US-001', priority: 1, passes: false }],
  })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const subagents = {
    async start() {
      await gate
      return {
        id: 'run-1',
        result: Promise.resolve({ stopReason: 'aborted', output: [] }),
        async dispose() {},
      }
    },
  }
  const { ctx, tools } = makeCtx({ subagents })
  apply(ctx, {})
  const first = tools[0].execute({}, { agent: agentAt(dir), signal: new AbortController().signal })
  // 让第一次调用进入运行状态
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await tools[0].execute({}, { agent: agentAt(dir), signal: new AbortController().signal })
  assert.match(second, /已有 Ralph 循环在运行/)
  release()
  await first
  // 第一次释放后可以再次运行
  const third = await tools[0].execute({ dryRun: true }, { agent: agentAt(dir) })
  assert.match(third, /MyApp/)
})

test('parseCommandInput 支持轮数与 status', () => {
  assert.deepEqual(parseCommandInput('', 10), { mode: 'run', maxIterations: 10 })
  assert.deepEqual(parseCommandInput(' 5 ', 10), { mode: 'run', maxIterations: 5 })
  assert.deepEqual(parseCommandInput('status', 10), { mode: 'status', maxIterations: 10 })
  assert.deepEqual(parseCommandInput('--status', 10), { mode: 'status', maxIterations: 10 })
  assert.deepEqual(parseCommandInput('abc', 10), { mode: 'run', maxIterations: 10 })
  assert.deepEqual(parseCommandInput('0', 10), { mode: 'run', maxIterations: 10 })
})

test('命令 handler 返回 success/error 结算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-plugin-'))
  writePrd(join(dir, 'prd.json'), {
    project: 'MyApp',
    userStories: [{ id: 'US-001', priority: 1, passes: false }],
  })
  const subagents = {
    async start() {
      return {
        id: 'run-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: COMPLETE_MARKER }] }),
        async dispose() {},
      }
    },
  }
  const { ctx, commands } = makeCtx({ subagents })
  apply(ctx, {})
  const ok = await commands[0].handler({ agent: agentAt(dir), rawInput: '' })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /Ralph 已完成/)

  const missing = await commands[0].handler({ agent: agentAt(join(dir, '不存在')), rawInput: 'status' })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /未找到 PRD 文件/)
})

test('renderOutcome 覆盖各终止状态', () => {
  assert.match(renderOutcome({ status: LOOP_STATUS.COMPLETE, message: 'm', history: [] }), /已完成全部用户故事/)
  assert.match(renderOutcome({ status: LOOP_STATUS.MAX_ITERATIONS, message: 'm', history: [] }), /最大迭代轮数/)
  assert.match(renderOutcome({ status: LOOP_STATUS.ABORTED, message: 'm', history: [] }), /已被取消/)
  assert.match(renderOutcome({ status: LOOP_STATUS.ERROR, message: 'm', history: [] }), /连续失败/)
  assert.match(renderOutcome({ status: LOOP_STATUS.PRECONDITION_FAILED, message: 'm', history: [] }), /无法启动/)

  const withHistory = renderOutcome({
    status: LOOP_STATUS.COMPLETE,
    message: 'm',
    history: [
      { iteration: 1, storyId: 'US-001', completed: true, durationMs: 1200 },
      { iteration: 2, storyId: null, completed: false, stopReason: 'max-tokens', durationMs: 800 },
    ],
  })
  assert.match(withHistory, /#1 US-001 · 完成 · 1s/)
  assert.match(withHistory, /#2 — · max-tokens · 1s/)
})
