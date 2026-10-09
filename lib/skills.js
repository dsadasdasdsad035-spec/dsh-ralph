/**
 * 随插件分发的技能（skill）加载。
 *
 * DSH 没有任何「自动加载插件包内 skills 目录」的机制：`dsh-skill-filesystem`
 * 只扫描项目/用户 skill 根目录，且刻意不支持嵌套的 `**​/SKILL.md`。官方包
 * `dsh-agent-preset` 虽然带了 `skills/` 目录，但它的代码里没有任何加载逻辑，
 * 那些文件永远不会生效。
 *
 * 要让插件自带技能，必须由插件自己注册。官方 `dsh-skill` 提供两个入口：
 *   - `ctx.skills.register(skill)`         —— 注册内存中的 skill（本模块采用）
 *   - `ctx.skills.registerProvider(...)`   —— 注册提供方目录（dsh-skill-badge 用的）
 *
 * 本模块只做「读文件 + 解析 frontmatter」，不依赖任何 `@deepseek-ai/*` 内部包；
 * 注册动作由 `lib/index.js` 通过注入的 `ctx.skills` 完成。
 */

import { readFileSync } from 'node:fs'

/** 随包分发的技能清单（相对本文件定位，不依赖进程工作目录）。 */
const BUNDLED_SKILLS = [
  { fallbackName: 'ralph', url: new URL('../skills/ralph/SKILL.md', import.meta.url) },
  { fallbackName: 'prd', url: new URL('../skills/prd/SKILL.md', import.meta.url) },
]

/**
 * 去掉 YAML 标量两端成对的引号。
 *
 * @param {string} value - 原始标量文本。
 * @returns {string} 去引号后的文本。
 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 解析 frontmatter 里的顶层 `key: value` 标量。
 *
 * 只处理扁平标量（技能 frontmatter 的实际形态），未知行被忽略；不引入 YAML 依赖。
 *
 * @param {string} raw - frontmatter 内的文本。
 * @returns {Record<string, string>} 键值映射。
 */
function parseFrontmatterAttributes(raw) {
  const attributes = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    attributes[match[1]] = unquote(match[2].trim())
  }
  return attributes
}

/**
 * 拆分 SKILL.md 的 frontmatter 与正文。
 *
 * @param {string} text - SKILL.md 全文。
 * @returns {{ attributes: Record<string, string>, body: string }} 解析结果。
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { attributes: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { attributes: {}, body: normalized }
  const attributes = parseFrontmatterAttributes(normalized.slice(3, end))
  const body = normalized.slice(end + 4).replace(/^\s+/, '')
  return { attributes, body }
}

/**
 * 按 `dsh-skill-filesystem` 的语义解析布尔字段。
 *
 * 接受 true/false、yes/no、on/off、1/0（不区分大小写），与官方文档一致。
 *
 * @param {string | undefined} value - 原始值。
 * @param {boolean} fallback - 缺省时的取值。
 * @returns {boolean} 解析结果。
 */
export function parseBooleanAttribute(value, fallback) {
  if (value === undefined) return fallback
  switch (String(value).trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false
    default:
      return fallback
  }
}

/**
 * 读取并组装随包技能定义。
 *
 * 缺少 `description` 的技能会被跳过：`ctx.skills.register()` 会以
 * 「requires a description」直接抛错，跳过可避免一个坏文件拖垮整个插件。
 *
 * @param {(level: string, message: string) => void} [log] - 可选的告警回调。
 * @returns {Array<{ name: string, description: string, content: string, invocation: { modelInvocable: boolean, userInvocable: boolean } }>} 技能定义列表。
 */
export function loadBundledSkills(log) {
  const skills = []
  for (const entry of BUNDLED_SKILLS) {
    let text
    try {
      text = readFileSync(entry.url, 'utf8')
    } catch (error) {
      log?.('warn', `读取随包技能失败（${entry.fallbackName}）：${String(error)}`)
      continue
    }
    const { attributes, body } = parseSkillFile(text)
    const name = typeof attributes.name === 'string' && attributes.name.length > 0
      ? attributes.name
      : entry.fallbackName
    const description = typeof attributes.description === 'string' ? attributes.description : ''
    if (description.length === 0) {
      log?.('warn', `随包技能 ${name} 缺少 description，已跳过`)
      continue
    }
    skills.push({
      name,
      description,
      content: body,
      invocation: {
        modelInvocable: !parseBooleanAttribute(attributes['disable-model-invocation'], false),
        userInvocable: parseBooleanAttribute(attributes['user-invocable'], true),
      },
    })
  }
  return skills
}
