/**
 * skills.js 的单元测试：frontmatter 解析与随包技能组装。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadBundledSkills, parseBooleanAttribute, parseSkillFile } from '../lib/skills.js'

test('parseSkillFile 拆分 frontmatter 与正文', () => {
  const text = [
    '---',
    'name: demo',
    'description: "一段描述"',
    'user-invocable: true',
    '---',
    '',
    '# 标题',
    '',
    '正文内容。',
    '',
  ].join('\n')
  const { attributes, body } = parseSkillFile(text)
  assert.equal(attributes.name, 'demo')
  assert.equal(attributes.description, '一段描述')
  assert.equal(attributes['user-invocable'], 'true')
  assert.equal(body, '# 标题\n\n正文内容。\n')
})

test('parseSkillFile 处理没有 frontmatter 的文件', () => {
  const { attributes, body } = parseSkillFile('# 纯正文\n')
  assert.deepEqual(attributes, {})
  assert.equal(body, '# 纯正文\n')
})

test('parseSkillFile 处理未闭合的 frontmatter', () => {
  const text = '---\nname: broken\n# 没有结束分隔符'
  const { attributes, body } = parseSkillFile(text)
  assert.deepEqual(attributes, {})
  assert.equal(body, text)
})

test('parseSkillFile 去掉前导 BOM 与正文前的空行', () => {
  const text = '\uFEFF---\nname: x\ndescription: "y"\n---\n\n\n# 正文\n'
  const { attributes, body } = parseSkillFile(text)
  assert.equal(attributes.name, 'x')
  assert.equal(body, '# 正文\n')
})

test('parseSkillFile 支持单引号与无引号标量', () => {
  const { attributes } = parseSkillFile("---\nname: 'q'\ndescription: 裸值\ndisable-model-invocation: true\n---\n正文")
  assert.equal(attributes.name, 'q')
  assert.equal(attributes.description, '裸值')
  assert.equal(attributes['disable-model-invocation'], 'true')
})

test('parseSkillFile 忽略无冒号的行与嵌套结构', () => {
  const { attributes } = parseSkillFile('---\nname: ok\n  - 列表项\nmetadata:\n  author: x\n---\nbody')
  assert.equal(attributes.name, 'ok')
  // 嵌套键按扁平化处理：只保留第一个冒号前的内容
  assert.equal(attributes.metadata, '')
})

test('parseBooleanAttribute 接受官方文档列出的全部拼写', () => {
  for (const truthy of ['true', 'TRUE', 'yes', 'Yes', 'on', 'ON', '1']) {
    assert.equal(parseBooleanAttribute(truthy, false), true, truthy)
  }
  for (const falsy of ['false', 'FALSE', 'no', 'No', 'off', 'OFF', '0']) {
    assert.equal(parseBooleanAttribute(falsy, true), false, falsy)
  }
  assert.equal(parseBooleanAttribute(undefined, true), true)
  assert.equal(parseBooleanAttribute(undefined, false), false)
  // 无法识别的拼写回退默认值（官方会把整个 skill 丢弃；这里保持宽松）
  assert.equal(parseBooleanAttribute('maybe', true), true)
})

test('loadBundledSkills 读到随包的两个技能且形态正确', () => {
  const skills = loadBundledSkills()
  assert.equal(skills.length, 2)
  const names = skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['prd', 'ralph'])
  for (const skill of skills) {
    assert.ok(skill.description.length > 0, `${skill.name} 应有 description`)
    assert.ok(skill.content.length > 100, `${skill.name} 应有正文`)
    // 正文不应残留 frontmatter
    assert.doesNotMatch(skill.content, /^---/)
    assert.ok(!skill.content.includes('name: ' + skill.name), `${skill.name} 正文不应含 frontmatter 行`)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  }
})

test('loadBundledSkills 的 description 含中文触发词（供模型路由）', () => {
  const skills = loadBundledSkills()
  const ralph = skills.find((skill) => skill.name === 'ralph')
  assert.match(ralph.description, /中文触发/)
})

test('每个技能都带 source（回归 v1.1.0 的加载失败）', () => {
  // v1.1.0 漏了 source：`ctx.skills.register()` 不校验它，所以注册成功、技能
  // 也能列进目录，但一旦加载正文，官方 validateDefinition 就会抛
  // `loaded skill "x" source must be a string`。
  for (const skill of loadBundledSkills()) {
    assert.equal(typeof skill.source, 'string', `${skill.name}.source 必须是字符串`)
    assert.equal(skill.source, 'bundled')
    assert.equal(typeof skill.content, 'string')
    assert.ok(skill.content.length > 100)
  }
})
