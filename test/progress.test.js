/**
 * progress.js 与 prompt.js 的单元测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  archivePreviousRun,
  ensureProgressFile,
  formatDate,
  readLastBranch,
  resetProgressFile,
  stripRalphPrefix,
  writeLastBranch,
} from '../lib/progress.js'
import { loadTemplate, renderIterationPrompt, renderTemplate, DEFAULT_TEMPLATE_FILE } from '../lib/prompt.js'

/** 建一个临时工作目录。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-ralph-'))
}

test('formatDate 输出本地 YYYY-MM-DD', () => {
  assert.equal(formatDate(new Date(2026, 9, 9)), '2026-10-09')
})

test('stripRalphPrefix 去掉 ralph/ 前缀', () => {
  assert.equal(stripRalphPrefix('ralph/task-priority'), 'task-priority')
  assert.equal(stripRalphPrefix('feature/x'), 'feature/x')
})

test('ensureProgressFile 只在文件缺失时创建', () => {
  const dir = tempDir()
  const file = join(dir, 'progress.txt')
  assert.equal(ensureProgressFile(file), true)
  const content = readFileSync(file, 'utf8')
  assert.match(content, /^# Ralph Progress Log/)
  assert.equal(ensureProgressFile(file), false)
})

test('resetProgressFile 覆盖为全新头部', () => {
  const dir = tempDir()
  const file = join(dir, 'progress.txt')
  writeFileSync(file, '旧内容', 'utf8')
  resetProgressFile(file)
  assert.match(readFileSync(file, 'utf8'), /^# Ralph Progress Log/)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /旧内容/)
})

test('readLastBranch / writeLastBranch 往返', () => {
  const dir = tempDir()
  const file = join(dir, '.last-branch')
  assert.equal(readLastBranch(file), '')
  writeLastBranch(file, 'ralph/a')
  assert.equal(readLastBranch(file), 'ralph/a')
})

test('archivePreviousRun 在分支切换时归档并重置进度', () => {
  const dir = tempDir()
  const prdFile = join(dir, 'prd.json')
  const progressFile = join(dir, 'progress.txt')
  const lastBranchFile = join(dir, '.last-branch')
  writeFileSync(prdFile, JSON.stringify({ branchName: 'ralph/new' }), 'utf8')
  writeFileSync(progressFile, '上一轮的进展', 'utf8')
  writeLastBranch(lastBranchFile, 'ralph/old')

  const result = archivePreviousRun({
    archiveRoot: join(dir, 'archive'),
    branchName: 'ralph/new',
    prdFile,
    progressFile,
    lastBranchFile,
    now: new Date(2026, 9, 9),
  })

  assert.equal(result.archived, true)
  assert.equal(result.branch, 'ralph/old')
  assert.equal(result.folder, join(dir, 'archive', '2026-10-09-old'))
  assert.equal(existsSync(join(result.folder, 'prd.json')), true)
  assert.equal(readFileSync(join(result.folder, 'progress.txt'), 'utf8'), '上一轮的进展')
  // 归档后 progress.txt 被重置
  assert.match(readFileSync(progressFile, 'utf8'), /^# Ralph Progress Log/)
  assert.doesNotMatch(readFileSync(progressFile, 'utf8'), /上一轮的进展/)
})

test('archivePreviousRun 在同分支或缺失记录时不归档', () => {
  const dir = tempDir()
  const prdFile = join(dir, 'prd.json')
  const progressFile = join(dir, 'progress.txt')
  const lastBranchFile = join(dir, '.last-branch')
  writeFileSync(prdFile, '{}', 'utf8')

  // 没有 .last-branch
  assert.equal(archivePreviousRun({
    archiveRoot: join(dir, 'archive'),
    branchName: 'ralph/x',
    prdFile,
    progressFile,
    lastBranchFile,
  }).archived, false)

  // 同分支
  writeLastBranch(lastBranchFile, 'ralph/x')
  assert.equal(archivePreviousRun({
    archiveRoot: join(dir, 'archive'),
    branchName: 'ralph/x',
    prdFile,
    progressFile,
    lastBranchFile,
  }).archived, false)

  // 分支名为空
  assert.equal(archivePreviousRun({
    archiveRoot: join(dir, 'archive'),
    branchName: '',
    prdFile,
    progressFile,
    lastBranchFile,
  }).archived, false)

  assert.equal(existsSync(join(dir, 'archive')), false)
})

test('renderTemplate 替换已知变量并保留未知占位符', () => {
  const out = renderTemplate('A={{a}} B={{ b }} C={{c}}', { a: 1, b: 'x' })
  assert.equal(out, 'A=1 B=x C={{c}}')
})

test('renderTemplate 把 null/undefined 渲染为空串', () => {
  assert.equal(renderTemplate('[{{a}}][{{b}}]', { a: null, b: undefined }), '[][]')
})

test('内置模板可加载且包含关键指令', () => {
  const template = loadTemplate(undefined)
  assert.ok(template.length > 500)
  assert.match(template, /<promise>COMPLETE<\/promise>/)
  assert.match(template, /Codebase Patterns/)
  assert.match(template, /AGENTS\.md/)
  // 不应残留 Amp 专有指令
  assert.doesNotMatch(template, /ampcode\.com/)
  assert.doesNotMatch(template, /AMP_CURRENT_THREAD_ID/)
})

test('DEFAULT_TEMPLATE_FILE 指向存在的文件', () => {
  assert.equal(existsSync(DEFAULT_TEMPLATE_FILE), true)
})

test('renderIterationPrompt 注入变量与指定故事', () => {
  const template = '第 {{iteration}}/{{maxIterations}} 轮，读 {{prdPath}}，写 {{progressPath}}，根 {{workspaceRoot}}'
  const out = renderIterationPrompt({
    template,
    workspaceRoot: '/w',
    prdPath: 'prd.json',
    progressPath: 'progress.txt',
    iteration: 2,
    maxIterations: 5,
  })
  assert.equal(out, '第 2/5 轮，读 prd.json，写 progress.txt，根 /w')
  assert.doesNotMatch(out, /本轮指定的故事/)

  const withStory = renderIterationPrompt({
    template,
    workspaceRoot: '/w',
    prdPath: 'prd.json',
    progressPath: 'progress.txt',
    iteration: 1,
    maxIterations: 5,
    story: { id: 'US-003', title: '过滤任务' },
  })
  assert.match(withStory, /本轮指定的故事/)
  assert.match(withStory, /US-003 过滤任务/)
})
