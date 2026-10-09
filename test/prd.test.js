/**
 * prd.js 与 config.js 的单元测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describePrd, isPassed, pickNextStory, readPrd, summarizePrd, writePrd } from '../lib/prd.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'

/** 构造一个测试用 PRD。 */
function samplePrd() {
  return {
    project: 'MyApp',
    branchName: 'ralph/task-priority',
    userStories: [
      { id: 'US-001', title: '甲', priority: 3, passes: false },
      { id: 'US-002', title: '乙', priority: 1, passes: true },
      { id: 'US-003', title: '丙', priority: 2, passes: false },
    ],
  }
}

test('readPrd 读取合法文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-'))
  const file = join(dir, 'prd.json')
  writePrd(file, samplePrd())
  const loaded = readPrd(file)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.prd.project, 'MyApp')
})

test('readPrd 报告缺失文件', () => {
  const loaded = readPrd(join(tmpdir(), 'dsh-ralph-不存在', 'prd.json'))
  assert.equal(loaded.ok, false)
  assert.match(loaded.error, /未找到 PRD 文件/)
})

test('readPrd 报告非法 JSON 与结构错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ralph-'))
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ 不是 json', 'utf8')
  assert.equal(readPrd(broken).ok, false)
  assert.match(readPrd(broken).error, /不是合法 JSON/)

  const noStories = join(dir, 'nostories.json')
  writeFileSync(noStories, JSON.stringify({ project: 'X' }), 'utf8')
  assert.equal(readPrd(noStories).ok, false)
  assert.match(readPrd(noStories).error, /userStories/)

  const arrayRoot = join(dir, 'array.json')
  writeFileSync(arrayRoot, '[]', 'utf8')
  assert.equal(readPrd(arrayRoot).ok, false)
  assert.match(readPrd(arrayRoot).error, /顶层必须是一个 JSON 对象/)
})

test('pickNextStory 按优先级升序且跳过已完成', () => {
  const next = pickNextStory(samplePrd())
  assert.equal(next.id, 'US-003')
})

test('pickNextStory 在优先级缺失时排最后并保持原始顺序', () => {
  const prd = {
    userStories: [
      { id: 'A', passes: false },
      { id: 'B', priority: 5, passes: false },
      { id: 'C', passes: false },
    ],
  }
  assert.equal(pickNextStory(prd).id, 'B')
})

test('pickNextStory 全部完成时返回 undefined', () => {
  const prd = { userStories: [{ id: 'A', passes: true }] }
  assert.equal(pickNextStory(prd), undefined)
})

test('summarizePrd 统计进度', () => {
  const summary = summarizePrd(samplePrd())
  assert.equal(summary.total, 3)
  assert.equal(summary.passed, 1)
  assert.equal(summary.pending, 2)
  assert.equal(summary.percent, 33)
  assert.equal(summary.allPassed, false)
  assert.equal(summary.next.id, 'US-003')
})

test('summarizePrd 处理空 PRD', () => {
  const summary = summarizePrd({ userStories: [] })
  assert.equal(summary.total, 0)
  assert.equal(summary.percent, 0)
  assert.equal(summary.allPassed, false)
})

test('isPassed 只认可布尔真值', () => {
  assert.equal(isPassed({ passes: true }), true)
  assert.equal(isPassed({ passes: 'true' }), false)
  assert.equal(isPassed({}), false)
  assert.equal(isPassed(undefined), false)
})

test('describePrd 生成可读描述', () => {
  assert.match(describePrd(samplePrd()), /MyApp：1\/3 完成（33%）/)
  assert.match(describePrd(samplePrd()), /US-003/)
  const done = { project: 'P', userStories: [{ id: 'A', passes: true }] }
  assert.match(describePrd(done), /全部故事已完成/)
})

test('normalizeConfig 补齐默认值', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.maxIterations, DEFAULT_CONFIG.maxIterations)
  assert.equal(config.provider, 'spawn')
  assert.equal(config.prdPath, 'prd.json')
  assert.equal(config.archiveOnBranchChange, true)
})

test('normalizeConfig 保留合法覆盖并拒绝非法类型', () => {
  const config = normalizeConfig({
    maxIterations: 3,
    provider: 'custom',
    prdPath: 'docs/prd.json',
    archiveOnBranchChange: false,
    maxConsecutiveFailures: 5,
    toolName: null,
  })
  assert.equal(config.maxIterations, 3)
  assert.equal(config.provider, 'custom')
  assert.equal(config.prdPath, 'docs/prd.json')
  assert.equal(config.archiveOnBranchChange, false)
  assert.equal(config.maxConsecutiveFailures, 5)
  assert.equal(config.toolName, null)

  const bogus = normalizeConfig({ maxIterations: -1, provider: '', archiveOnBranchChange: 'yes', persona: 42 })
  assert.equal(bogus.maxIterations, DEFAULT_CONFIG.maxIterations)
  assert.equal(bogus.provider, 'spawn')
  assert.equal(bogus.archiveOnBranchChange, true)
  assert.equal(bogus.persona, null)
})
