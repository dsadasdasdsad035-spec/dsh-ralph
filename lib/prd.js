/**
 * PRD 读写与进度统计。
 *
 * 原版 ralph.sh 用 jq 从 prd.json 读取 branchName 并据此归档历史运行；
 * 本模块把同一套语义实现为可测试的纯函数 + 少量文件操作。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * 读取并解析 prd.json。
 *
 * @param {string} file - prd.json 的绝对路径。
 * @returns {{ ok: true, prd: object } | { ok: false, error: string }} 解析结果。
 */
export function readPrd(file) {
  if (!existsSync(file)) return { ok: false, error: `未找到 PRD 文件：${file}` }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读取 PRD 文件失败：${String(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `PRD 文件不是合法 JSON：${String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'PRD 文件顶层必须是一个 JSON 对象' }
  }
  if (!Array.isArray(parsed.userStories)) {
    return { ok: false, error: 'PRD 文件缺少 userStories 数组' }
  }
  return { ok: true, prd: parsed }
}

/**
 * 写回 prd.json（保留两空格缩进，与原版工具链的可读性一致）。
 *
 * @param {string} file - prd.json 的绝对路径。
 * @param {object} prd - 待写入的 PRD 对象。
 */
export function writePrd(file, prd) {
  writeFileSync(file, `${JSON.stringify(prd, null, 2)}\n`, 'utf8')
}

/**
 * 判断单个用户故事是否已完成。
 *
 * @param {object} story - 用户故事条目。
 * @returns {boolean} `passes === true` 时为真。
 */
export function isPassed(story) {
  return story?.passes === true
}

/**
 * 按优先级挑选下一个待办故事。
 *
 * 优先级语义与原版 Ralph 一致：`priority` 数值越小越优先；缺失优先级的故事
 * 排在最后，同级时保持 PRD 中的原始顺序（稳定排序）。
 *
 * @param {object} prd - PRD 对象。
 * @returns {object | undefined} 下一个待办故事，全部完成时返回 undefined。
 */
export function pickNextStory(prd) {
  const pending = (prd?.userStories ?? [])
    .map((story, index) => ({ story, index }))
    .filter(({ story }) => !isPassed(story))
  if (pending.length === 0) return undefined
  pending.sort((a, b) => {
    const pa = typeof a.story.priority === 'number' ? a.story.priority : Number.POSITIVE_INFINITY
    const pb = typeof b.story.priority === 'number' ? b.story.priority : Number.POSITIVE_INFINITY
    if (pa !== pb) return pa - pb
    return a.index - b.index
  })
  return pending[0].story
}

/**
 * 汇总 PRD 的完成进度。
 *
 * @param {object} prd - PRD 对象。
 * @returns {{ total: number, passed: number, pending: number, percent: number, next: object | undefined, allPassed: boolean }} 进度摘要。
 */
export function summarizePrd(prd) {
  const stories = Array.isArray(prd?.userStories) ? prd.userStories : []
  const total = stories.length
  const passed = stories.filter(isPassed).length
  const pending = total - passed
  const percent = total === 0 ? 0 : Math.round((passed / total) * 100)
  return {
    total,
    passed,
    pending,
    percent,
    next: pickNextStory(prd),
    allPassed: total > 0 && pending === 0,
  }
}

/**
 * 渲染一行人类可读的进度描述，用于命令行/工具输出。
 *
 * @param {object} prd - PRD 对象。
 * @returns {string} 形如 `MyApp（3/5 完成，60%）下一个：US-004 ...` 的描述。
 */
export function describePrd(prd) {
  const summary = summarizePrd(prd)
  const project = typeof prd?.project === 'string' && prd.project.length > 0 ? prd.project : '未命名项目'
  const head = `${project}：${summary.passed}/${summary.total} 完成（${summary.percent}%）`
  if (summary.allPassed) return `${head}，全部故事已完成`
  if (summary.total === 0) return `${head}，PRD 中没有任何用户故事`
  const next = summary.next
  const label = next?.id !== undefined ? `${next.id} ${next.title ?? ''}`.trim() : '未知'
  return `${head}，下一个：${label}`
}
