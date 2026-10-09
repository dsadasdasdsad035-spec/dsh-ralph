/**
 * 插件的 schemastery 配置 schema。
 *
 * 按 DSH 官方规范，函数式插件通过 `export const Config` 声明配置 schema：
 * loader 在激活时用它校验 profile patch 行里的 `config`，并据此生成设置页。
 *
 * 这里只做「声明与校验」；`lib/config.js` 的 `normalizeConfig()` 仍会在
 * `apply()` 内再兜底一次，因此即使配置缺项或类型异常，插件也不会加载失败。
 */

import z from '@deepseek-ai/schemastery'

/** 允许「字符串或 null（表示禁用）」的可选名称字段。 */
const optionalName = z.union([z.string(), z.const(null)])

/** profile 中 `config:` 的 schema。 */
export const Config = z.object({
  /** 最大迭代轮数。 */
  maxIterations: z.natural().min(1).default(10),
  /** 子 agent 提供方名称。 */
  provider: z.string().default('spawn'),
  /** PRD 文件（相对会话工作目录）。 */
  prdPath: z.string().default('prd.json'),
  /** 进度日志（相对会话工作目录）。 */
  progressPath: z.string().default('progress.txt'),
  /** 归档目录（相对会话工作目录）。 */
  archiveDir: z.string().default('archive'),
  /** 记录上一轮分支的文件（相对会话工作目录）。 */
  lastBranchFile: z.string().default('.last-branch'),
  /** 分支切换时归档上一轮运行。 */
  archiveOnBranchChange: z.boolean().default(true),
  /** 自定义提示词模板路径。 */
  promptFile: z.string(),
  /** 子 agent 的模型路由覆盖，例如 { provider, model, reasoningEffort }。 */
  agentOptions: z.any(),
  /** 子 agent 的 persona。 */
  persona: z.string(),
  /** 连续失败多少轮后放弃。 */
  maxConsecutiveFailures: z.natural().min(1).default(3),
  /** 是否在每轮提示词中指定本轮故事。 */
  storyPerIteration: z.boolean().default(true),
  /**
   * 注册的工具名；`null` 表示不注册工具。
   *
   * 刻意不加 `.default()`：schemastery 的默认值会把显式 `null` 也一并替换掉，
   * 导致「写 null 禁用」失效。缺省（undefined）交由 `normalizeConfig()` 补默认值。
   */
  toolName: optionalName,
  /** 注册的命令名；`null` 表示不注册命令（同上，不使用 `.default()`）。 */
  commandName: optionalName,
  /** 是否把随包技能注册到 `ctx.skills`。 */
  bundleSkills: z.boolean().default(true),
  /** 工具超时毫秒数；不设置表示不受工具超时策略约束。 */
  timeoutMs: z.natural(),
})
