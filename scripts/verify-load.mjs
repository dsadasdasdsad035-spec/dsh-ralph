#!/usr/bin/env node
/**
 * 端到端装载验证。
 *
 * 用**真实的** @deepseek-ai/cordis 装载本插件，确认四件事：
 *   1. 导出形态符合 Cordis 的函数式插件约定（name / inject / Config / apply）；
 *   2. `Config`（schemastery）能被 Cordis 的 resolveConfig 正确解析并补默认值；
 *   3. `apply()` 确实把工具与命令注册到了注入的服务上；
 *   4. `apply()` 把随包的 ralph / prd 两个技能注册到了 `ctx.skills` 上
 *      （DSH 不会自动加载插件包内的 skills/ 目录，必须插件自己注册）。
 *
 * 这里用假的 tools / subagents / commands / skills 服务替代 Host 实现，因此
 * 不需要启动 DSH，也不会真的派生任何子 agent。用法：
 *
 * ```bash
 * npm install          # 或把 node_modules/@deepseek-ai/{cordis,schemastery} 链接到 profile
 * node scripts/verify-load.mjs
 * ```
 */

import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'

/** 收集注册结果。 */
const tools = []
const commands = []
const skills = []
const logs = []

/** 假的服务实现：只记录调用，不产生副作用。 */
const toolsService = {
  register(definition) {
    tools.push(definition)
    return () => {}
  },
  get() {
    return undefined
  },
}

const commandsService = {
  register(command) {
    commands.push(command)
    return () => {}
  },
}

const skillsService = {
  register(skill) {
    // 模拟 ctx.skills.register 的默认值补全：官方会补 invocation 与 provider。
    skills.push({
      ...skill,
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      provider: skill.provider ?? 'runtime',
    })
    return () => {}
  },
}

/**
 * 照抄官方 `dsh-skill` 加载路径的 `validateDefinition` 字段校验。
 *
 * `ctx.skills.register()` 只校验 name / description / invocation，而**加载**
 * 走的是更严格的一套。只验注册侧会漏掉 `source` 这类必填字段——那正是
 * v1.1.0 的 bug：技能能列出来，一加载就报 `source must be a string`。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function validateLoadedSkill(skill) {
  if (typeof skill.name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (!SKILL_NAME_PATTERN.test(skill.name)) throw new Error(`loaded skill has invalid name "${skill.name}"`)
  if (typeof skill.description !== 'string') throw new TypeError(`loaded skill "${skill.name}" description must be a string`)
  if (skill.description.length === 0) throw new Error(`loaded skill "${skill.name}" requires a description`)
  if (skill.whenToUse !== undefined && typeof skill.whenToUse !== 'string') throw new TypeError(`loaded skill "${skill.name}" whenToUse must be a string`)
  if (typeof skill.source !== 'string') throw new TypeError(`loaded skill "${skill.name}" source must be a string`)
  if (typeof skill.provider !== 'string') throw new TypeError(`loaded skill "${skill.name}" provider must be a string`)
  if (typeof skill.content !== 'string') throw new TypeError(`loaded skill "${skill.name}" content must be a string`)
  if (skill.path !== undefined && typeof skill.path !== 'string') throw new TypeError(`loaded skill "${skill.name}" path must be a string`)
}

const subagentsService = {
  async start() {
    throw new Error('验证脚本不应真正启动子 agent')
  },
}

const ctx = new Context()

// 注入插件声明依赖的服务，以及可选的 commands / skills 服务。
ctx.provide('tools', toolsService)
ctx.provide('subagents', subagentsService)
ctx.provide('commands', commandsService)
ctx.provide('skills', skillsService)

// 用最小的 logger 实现覆盖日志输出，便于断言。
ctx.provide('logger', Object.assign(
  (scope) => ({
    info: (message) => logs.push(`info:${scope ?? ''}:${message}`),
    warn: (message) => logs.push(`warn:${scope ?? ''}:${message}`),
    error: (message) => logs.push(`error:${scope ?? ''}:${message}`),
    debug: () => {},
  }),
  {
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
    error: (message) => logs.push(`error:${message}`),
    debug: () => {},
  },
))

/** 逐步输出检查结果。 */
const steps = []
const check = (label, fn) => {
  fn()
  steps.push(label)
}

// 1) 导出形态
check('导出 name 为 dsh-ralph', () => assert.equal(plugin.name, 'dsh-ralph'))
check('导出 inject 声明 tools 与 subagents', () => {
  assert.deepEqual([...plugin.inject], ['tools', 'subagents'])
})
check('导出 Config schema 与 apply', () => {
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')
})

// 2) 真的挂载到 Cordis：这一步会走 loader 的 resolveConfig(Config) 校验
const fiber = await ctx.plugin(plugin, { maxIterations: 4, commandName: 'ralphx' })
steps.push('Cordis 成功装载插件（inject 解析 + Config 校验通过）')

// 3) 注册结果
check('注册了一个名为 ralph 的工具', () => {
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'ralph')
  assert.equal(typeof tools[0].execute, 'function')
  assert.equal(typeof tools[0].output.render, 'function')
})
check('工具参数 schema 属于受支持子集', () => {
  const parameters = tools[0].parameters
  assert.equal(parameters.type, 'object')
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['dryRun', 'maxIterations'])
  assert.deepEqual(parameters.required, [])
  assert.equal(parameters.properties.maxIterations.type, 'number')
  assert.equal(parameters.properties.dryRun.type, 'boolean')
})
check('注册了一个名为 ralphx 的命令（config 生效）', () => {
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'ralphx')
  assert.equal(typeof commands[0].handler, 'function')
})
check('注册了随包的 ralph / prd 两个技能', () => {
  assert.equal(skills.length, 2)
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['prd', 'ralph'])
  for (const skill of skills) {
    // 关键：用加载路径的严格校验器验证，而不只是看注册收到了什么
    validateLoadedSkill(skill)
    assert.equal(skill.source, 'bundled')
    assert.equal(skill.provider, 'runtime')
    assert.equal(typeof skill.description, 'string')
    assert.ok(skill.description.length > 0, `${skill.name} 必须有 description`)
    assert.ok(skill.content.length > 100, `${skill.name} 必须有正文`)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    // 正文里不应残留 frontmatter
    assert.doesNotMatch(skill.content, /^---/)
  }
})
check('日志中未出现加载错误', () => {
  assert.equal(logs.filter((line) => line.startsWith('error:')).length, 0)
})

// 4) 卸载：Cordis 的 fiber.dispose() 应回收插件
await fiber.dispose()
steps.push('fiber.dispose() 正常回收')

console.log('✅ 插件装载验证通过：')
for (const step of steps) console.log(`   · ${step}`)
