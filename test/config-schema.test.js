/**
 * config-schema.js 的回归测试。
 *
 * 这里刻意用动态 import：`@deepseek-ai/schemastery` 是 Host 提供的 peer 依赖，
 * 在未安装依赖的环境下整组测试应跳过，而不是让整个测试套件失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let Config
let loadError
try {
  ({ Config } = await import('../lib/config-schema.js'))
} catch (error) {
  loadError = error
}

/** 缺少 peer 依赖时跳过（Node 内置 test runner 的 skip 语义）。 */
const withConfig = Config === undefined ? test.skip : test

if (Config === undefined) {
  test('config-schema 跳过（未安装 @deepseek-ai/schemastery）', () => {
    assert.ok(loadError !== undefined)
  })
}

withConfig('空配置得到全部默认值', () => {
  const config = Config({})
  assert.equal(config.maxIterations, 10)
  assert.equal(config.provider, 'spawn')
  assert.equal(config.prdPath, 'prd.json')
  assert.equal(config.progressPath, 'progress.txt')
  assert.equal(config.archiveOnBranchChange, true)
  assert.equal(config.maxConsecutiveFailures, 3)
  assert.equal(config.storyPerIteration, true)
})

withConfig('显式 null 能禁用工具与命令（不被默认值吞掉）', () => {
  assert.equal(Config({ toolName: null }).toolName, null)
  assert.equal(Config({ commandName: null }).commandName, null)
})

withConfig('缺省时名称字段留空，交由 normalizeConfig 兜底', () => {
  assert.equal(Config({}).toolName, undefined)
  assert.equal(Config({}).commandName, undefined)
})

withConfig('合法覆盖被保留', () => {
  const config = Config({ maxIterations: 3, provider: 'custom', commandName: 'ralphx' })
  assert.equal(config.maxIterations, 3)
  assert.equal(config.provider, 'custom')
  assert.equal(config.commandName, 'ralphx')
})

withConfig('非法取值被 schema 拒绝', () => {
  assert.throws(() => Config({ maxIterations: 0 }), /maxIterations/)
  assert.throws(() => Config({ maxIterations: 'x' }), /maxIterations/)
  assert.throws(() => Config({ maxConsecutiveFailures: -1 }), /maxConsecutiveFailures/)
  assert.throws(() => Config({ maxIterations: 1.5 }), /maxIterations/)
})

withConfig('schema 解析结果经 normalizeConfig 后可用于 apply', async () => {
  const { normalizeConfig } = await import('../lib/config.js')
  // 关键回归点：schema 未给默认值的名称字段，必须由 normalizeConfig 补回 'ralph'。
  const disabled = normalizeConfig(Config({ toolName: null }))
  assert.equal(disabled.toolName, null)
  assert.equal(disabled.commandName, 'ralph')

  const plain = normalizeConfig(Config({}))
  assert.equal(plain.toolName, 'ralph')
  assert.equal(plain.commandName, 'ralph')
})
