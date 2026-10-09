/**
 * progress.txt 维护与历史运行归档。
 *
 * 完整移植原版 ralph.sh 的行为：
 *  1. 当 prd.json 的 branchName 与 `.last-branch` 记录不一致时，把上一轮运行的
 *     prd.json 与 progress.txt 归档到 `archive/<日期>-<分支名>/`，并重置 progress.txt；
 *  2. 每轮开始前把当前 branchName 写入 `.last-branch`；
 *  3. progress.txt 不存在时创建带头部的新文件。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 把时间格式化为归档目录使用的本地日期（YYYY-MM-DD）。
 *
 * @param {Date} [date] - 待格式化的时间，默认当前时间。
 * @returns {string} 本地日期字符串。
 */
export function formatDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 去掉分支名的 `ralph/` 前缀，用于生成归档子目录名（与原版 sed 行为一致）。
 *
 * @param {string} branchName - PRD 中的分支名。
 * @returns {string} 适合做目录名的分支名。
 */
export function stripRalphPrefix(branchName) {
  return String(branchName).replace(/^ralph\//, '')
}

/**
 * 读取记录上一轮分支的文件。
 *
 * @param {string} file - `.last-branch` 的绝对路径。
 * @returns {string} 记录的分支名，不存在时返回空字符串。
 */
export function readLastBranch(file) {
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 写入当前分支名（原版用 `echo "$CURRENT_BRANCH" > .last-branch`）。
 *
 * @param {string} file - `.last-branch` 的绝对路径。
 * @param {string} branchName - 当前 PRD 的分支名。
 */
export function writeLastBranch(file, branchName) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${branchName}\n`, 'utf8')
}

/**
 * 生成 progress.txt 的头部文本。
 *
 * @param {Date} now - 生成时间。
 * @returns {string} 头部内容（含结尾换行）。
 */
function progressHeader(now) {
  return `# Ralph Progress Log\nStarted: ${now.toString()}\n---\n`
}

/**
 * progress.txt 不存在时创建（原版行为）。
 *
 * @param {string} file - progress.txt 的绝对路径。
 * @param {{ now?: Date }} [options] - 可注入的时间，便于测试。
 * @returns {boolean} 本次是否创建了文件。
 */
export function ensureProgressFile(file, options = {}) {
  if (existsSync(file)) return false
  const now = options.now ?? new Date()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, progressHeader(now), 'utf8')
  return true
}

/**
 * 重置 progress.txt 为一个全新的头部（原版归档后执行）。
 *
 * @param {string} file - progress.txt 的绝对路径。
 * @param {{ now?: Date }} [options] - 可注入的时间，便于测试。
 */
export function resetProgressFile(file, options = {}) {
  const now = options.now ?? new Date()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, progressHeader(now), 'utf8')
}

/**
 * 当分支切换时归档上一轮运行。
 *
 * 与原版一致：只有 prd.json 与 `.last-branch` 同时存在、读取到的两个分支名
 * 都非空且不相等时才归档。归档会复制 prd.json 与 progress.txt（存在才复制），
 * 随后重置 progress.txt。
 *
 * @param {object} options - 归档参数。
 * @param {string} options.archiveRoot - archive 根目录的绝对路径。
 * @param {string} options.branchName - 当前 PRD 的分支名。
 * @param {string} options.prdFile - prd.json 的绝对路径。
 * @param {string} options.progressFile - progress.txt 的绝对路径。
 * @param {string} options.lastBranchFile - `.last-branch` 的绝对路径。
 * @param {Date} [options.now] - 可注入的时间，便于测试。
 * @returns {{ archived: true, folder: string, branch: string, date: string } | { archived: false }} 归档结果。
 */
export function archivePreviousRun(options) {
  const { archiveRoot, branchName, prdFile, progressFile, lastBranchFile } = options
  const now = options.now ?? new Date()
  if (!branchName) return { archived: false }
  const lastBranch = readLastBranch(lastBranchFile)
  if (!lastBranch || lastBranch === branchName) return { archived: false }

  const date = formatDate(now)
  const folder = join(archiveRoot, `${date}-${stripRalphPrefix(lastBranch)}`)
  mkdirSync(folder, { recursive: true })
  if (existsSync(prdFile)) copyFileSync(prdFile, join(folder, 'prd.json'))
  if (existsSync(progressFile)) copyFileSync(progressFile, join(folder, 'progress.txt'))
  resetProgressFile(progressFile, { now })
  return { archived: true, folder, branch: lastBranch, date }
}
