/**
 * 插件配置的默认值与归一化。
 *
 * 配置来自 profile 的 `cordis.patch.yml` 条目：
 *
 * ```yaml
 * - id: ralph
 *   name: dsh-ralph
 *   config:
 *     maxIterations: 10
 * ```
 *
 * 本模块不依赖 schemastery，手写归一化以便在配置缺失或类型错误时回退默认值，
 * 而不是让整个插件加载失败。
 */

import {
  DEFAULT_ARCHIVE_DIR,
  DEFAULT_COMMAND_NAME,
  DEFAULT_LAST_BRANCH_FILE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PRD_FILE,
  DEFAULT_PROGRESS_FILE,
  DEFAULT_PROVIDER,
  DEFAULT_TOOL_NAME,
} from './constants.js'

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 最大迭代轮数。 */
  maxIterations: DEFAULT_MAX_ITERATIONS,
  /** 子 agent 提供方名称（注册在 ctx.subagents 上）。 */
  provider: DEFAULT_PROVIDER,
  /** PRD 文件（相对会话工作目录）。 */
  prdPath: DEFAULT_PRD_FILE,
  /** 进度日志（相对会话工作目录）。 */
  progressPath: DEFAULT_PROGRESS_FILE,
  /** 归档目录（相对会话工作目录）。 */
  archiveDir: DEFAULT_ARCHIVE_DIR,
  /** 记录上一轮分支的文件（相对会话工作目录）。 */
  lastBranchFile: DEFAULT_LAST_BRANCH_FILE,
  /** 分支切换时归档上一轮运行。 */
  archiveOnBranchChange: true,
  /** 自定义提示词模板路径；null 表示使用包内置模板。 */
  promptFile: null,
  /** 传递给子 agent 的模型路由覆盖（provider/model/reasoningEffort）。 */
  agentOptions: null,
  /** 传递给子 agent 的 persona。 */
  persona: null,
  /** 连续失败多少轮后放弃。 */
  maxConsecutiveFailures: 3,
  /** 是否在每次迭代的提示词中指定本轮故事。 */
  storyPerIteration: true,
  /** 注册的工具名；null 表示不注册工具。 */
  toolName: DEFAULT_TOOL_NAME,
  /** 注册的命令名；null 表示不注册命令。 */
  commandName: DEFAULT_COMMAND_NAME,
  /** 是否把随包技能注册到 ctx.skills（安装即生效，无需手工拷贝）。 */
  bundleSkills: true,
  /** 工具超时（毫秒）；null 表示使用 Host 默认超时策略。 */
  timeoutMs: null,
})

/**
 * 读取布尔配置项，类型不符时回退默认值。
 *
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 默认值。
 * @returns {boolean} 归一化结果。
 */
function boolValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读取正数配置项，类型不符时回退默认值。
 *
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @returns {number} 归一化结果。
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 读取字符串配置项，空串或类型不符时回退默认值。
 *
 * @param {unknown} value - 原始值。
 * @param {string} fallback - 默认值。
 * @returns {string} 归一化结果。
 */
function stringValue(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * 读取可选字符串（允许 null 表示"不启用"）。
 *
 * @param {unknown} value - 原始值。
 * @param {string | null} fallback - 默认值。
 * @returns {string | null} 归一化结果。
 */
function optionalString(value, fallback) {
  if (value === null) return null
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * 归一化插件配置。
 *
 * @param {unknown} raw - 来自 profile 的原始配置。
 * @returns {typeof DEFAULT_CONFIG} 补齐默认值后的配置。
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    maxIterations: Math.floor(positiveNumber(input.maxIterations, DEFAULT_CONFIG.maxIterations)),
    provider: stringValue(input.provider, DEFAULT_CONFIG.provider),
    prdPath: stringValue(input.prdPath, DEFAULT_CONFIG.prdPath),
    progressPath: stringValue(input.progressPath, DEFAULT_CONFIG.progressPath),
    archiveDir: stringValue(input.archiveDir, DEFAULT_CONFIG.archiveDir),
    lastBranchFile: stringValue(input.lastBranchFile, DEFAULT_CONFIG.lastBranchFile),
    archiveOnBranchChange: boolValue(input.archiveOnBranchChange, DEFAULT_CONFIG.archiveOnBranchChange),
    promptFile: optionalString(input.promptFile, DEFAULT_CONFIG.promptFile),
    agentOptions: input.agentOptions !== null && typeof input.agentOptions === 'object' && !Array.isArray(input.agentOptions)
      ? input.agentOptions
      : DEFAULT_CONFIG.agentOptions,
    persona: optionalString(input.persona, DEFAULT_CONFIG.persona),
    maxConsecutiveFailures: Math.floor(positiveNumber(input.maxConsecutiveFailures, DEFAULT_CONFIG.maxConsecutiveFailures)),
    storyPerIteration: boolValue(input.storyPerIteration, DEFAULT_CONFIG.storyPerIteration),
    toolName: optionalString(input.toolName, DEFAULT_CONFIG.toolName),
    commandName: optionalString(input.commandName, DEFAULT_CONFIG.commandName),
    bundleSkills: boolValue(input.bundleSkills, DEFAULT_CONFIG.bundleSkills),
    timeoutMs: input.timeoutMs === null || input.timeoutMs === undefined
      ? DEFAULT_CONFIG.timeoutMs
      : positiveNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs),
  }
}
