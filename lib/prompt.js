/**
 * 迭代提示词渲染。
 *
 * 默认模板 `prompts/ralph-iteration.md` 由原版 Ralph 的 prompt.md / CLAUDE.md
 * 改造而来：去掉 Amp 专有的 thread 相关指令，改为 DSH 环境下的自主迭代说明。
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录（lib/ 的上一级），用于定位内置模板。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 内置模板路径。 */
export const DEFAULT_TEMPLATE_FILE = join(packageRoot, 'prompts', 'ralph-iteration.md')

/**
 * 读取提示词模板；自定义路径优先，其次内置模板。
 *
 * @param {string | undefined} customFile - 用户配置的模板路径（相对包根或绝对路径）。
 * @returns {string} 模板文本。
 */
export function loadTemplate(customFile) {
  if (customFile !== undefined && customFile !== null && customFile !== '') {
    const target = isAbsolute(customFile) ? customFile : resolve(process.cwd(), customFile)
    return readFileSync(target, 'utf8')
  }
  return readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8')
}

/**
 * 把模板中的 `{{key}}` 占位符替换为对应值。
 *
 * 未提供的键保持原样（便于发现模板与调用方不一致），值为 undefined 时替换为空串。
 *
 * @param {string} template - 模板文本。
 * @param {Record<string, unknown>} values - 变量表。
 * @returns {string} 渲染结果。
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!(key in values)) return match
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * 渲染一次迭代的完整提示词。
 *
 * @param {object} options - 渲染参数。
 * @param {string} options.template - 模板文本。
 * @param {string} options.workspaceRoot - 会话工作目录。
 * @param {string} options.prdPath - PRD 路径（用于写入提示词，通常是相对路径）。
 * @param {string} options.progressPath - 进度日志路径。
 * @param {number} options.iteration - 当前轮次（从 1 开始）。
 * @param {number} options.maxIterations - 最大轮次。
 * @param {object} [options.story] - 本轮指定的用户故事（可选）。
 * @returns {string} 渲染后的提示词。
 */
export function renderIterationPrompt(options) {
  const { template, workspaceRoot, prdPath, progressPath, iteration, maxIterations, story } = options
  const values = {
    workspaceRoot,
    prdPath,
    progressPath,
    iteration,
    maxIterations,
    storyId: story?.id ?? '',
    storyTitle: story?.title ?? '',
  }
  const rendered = renderTemplate(template, values)
  if (story === undefined) return rendered
  const label = story.id !== undefined ? `${story.id} ${story.title ?? ''}`.trim() : '指定的用户故事'
  return `${rendered}\n\n---\n\n## 本轮指定的故事\n\n本轮只实现这一个故事：**${label}**\n`
}
