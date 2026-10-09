#!/usr/bin/env node
/**
 * 把 dsh-ralph 安装到某个 DSH profile。
 *
 * 做三件事：
 *   1. 备份 profile 的 package.json；
 *   2. 通过官方 CLI 在 profile 目录里执行 pnpm 安装（`dsh plugin ... add -w`）；
 *   3. 把 `dsh-ralph` 写进 profile 的 `dsh.profile.bundles` 数组。
 *
 * 用法：
 *   node scripts/install.mjs                       # 安装到 desktop profile
 *   node scripts/install.mjs --profile web         # 指定 profile
 *   node scripts/install.mjs --dry-run             # 只打印计划
 *   node scripts/install.mjs --uninstall           # 移除
 *
 * ⚠️ `desktop` profile 由 DeepSeek Harness Desktop 独占，安装前必须完全退出它，
 *    否则 pnpm 会与正在运行的实例争用 profile 目录。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 本包的 package.json。 */
const manifestPath = join(packageRoot, 'package.json')

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{ profile: string, dryRun: boolean, uninstall: boolean, help: boolean }} 解析结果。
 */
function parseArgs(argv) {
  const options = { profile: 'desktop', dryRun: false, uninstall: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') {
      options.profile = argv[index + 1] ?? options.profile
      index += 1
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true
    } else if (arg === '--uninstall') {
      options.uninstall = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

/**
 * 定位 DSH 主目录（尊重 DSH_HOME）。
 *
 * @returns {string} `~/.dsh` 或 `$DSH_HOME`。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 打印帮助。 */
function printHelp() {
  console.log(`用法：node scripts/install.mjs [选项]

  -p, --profile <名称>  目标 profile，默认 desktop
  -n, --dry-run         只打印将要执行的步骤，不做任何修改
      --uninstall       从 profile 中移除 dsh-ralph
  -h, --help            显示本帮助`)
}

/**
 * 确认 DeepSeek Harness 未在运行（desktop profile 会被它独占）。
 *
 * @returns {boolean} 是否可以直接继续。
 */
function ensureDesktopClosed() {
  const probe = spawnSync('pgrep', ['-f', 'DeepSeek Harness'], { encoding: 'utf8' })
  if (probe.status === 0 && String(probe.stdout).trim().length > 0) {
    console.error('❌ 检测到 DeepSeek Harness 正在运行。')
    console.error('   请先完全退出（Dock 右键 → 退出，或 ⌘Q），再重新执行本脚本。')
    return false
  }
  return true
}

/**
 * 读入 profile 的 package.json。
 *
 * @param {string} file - package.json 路径。
 * @returns {object} 解析后的对象。
 */
function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 写回 profile 的 package.json（两空格缩进）。
 *
 * @param {string} file - package.json 路径。
 * @param {object} manifest - 待写入内容。
 */
function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 读取 profile 的 bundles 列表（缺失时返回空数组）。
 *
 * @param {object} manifest - profile 的 package.json。
 * @returns {string[]} bundles 数组副本。
 */
function readBundles(manifest) {
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) ? [...bundles] : []
}

/**
 * 执行命令并继承 stdio。
 *
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {string} cwd - 工作目录。
 * @returns {number} 退出码。
 */
function run(command, args, cwd) {
  console.log(`   $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  return result.status ?? 1
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const packageName = readManifest(manifestPath).name
const profileDir = join(dshHome(), 'profiles', options.profile)
const profileManifestPath = join(profileDir, 'package.json')

console.log(`插件包：${packageName}  (${packageRoot})`)
console.log(`目标 profile：${options.profile}  (${profileDir})`)
console.log(`模式：${options.uninstall ? '卸载' : '安装'}${options.dryRun ? '（dry-run）' : ''}`)
console.log('')

if (!existsSync(profileManifestPath)) {
  console.error(`❌ 找不到 profile 清单：${profileManifestPath}`)
  console.error('   请确认 profile 名称，或先启动一次 DeepSeek Harness 以初始化该 profile。')
  process.exit(1)
}

const manifest = readManifest(profileManifestPath)
const bundles = readBundles(manifest)
const alreadyBundled = bundles.includes(packageName)
const alreadyDependency = manifest.dependencies?.[packageName] !== undefined

if (options.uninstall) {
  const steps = []
  if (alreadyBundled) steps.push(`从 dsh.profile.bundles 移除 ${packageName}`)
  if (alreadyDependency) steps.push(`从 dependencies 移除 ${packageName}（执行 pnpm remove）`)
  if (steps.length === 0) {
    console.log('ℹ️  该 profile 未安装本插件，无需卸载。')
    process.exit(0)
  }
  for (const step of steps) console.log(`   · ${step}`)
  if (options.dryRun) {
    console.log('\n（dry-run，未做任何修改）')
    process.exit(0)
  }
  if (options.profile === 'desktop' && !ensureDesktopClosed()) process.exit(1)

  copyFileSync(profileManifestPath, `${profileManifestPath}.bak-${Date.now()}`)
  if (alreadyBundled) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== packageName)
    writeManifest(profileManifestPath, manifest)
  }
  if (alreadyDependency) {
    const code = run('pnpm', ['remove', '-w', packageName], profileDir)
    if (code !== 0) {
      console.error('❌ pnpm remove 失败，请检查上面的输出。')
      process.exit(code)
    }
  }
  console.log('\n✅ 已卸载。请重启 DeepSeek Harness 使改动生效。')
  process.exit(0)
}

if (alreadyBundled && alreadyDependency) {
  console.log('ℹ️  该 profile 已安装本插件。若只改了源码，重启 Host 即可生效。')
  process.exit(0)
}

console.log('将执行：')
if (!alreadyDependency) console.log(`   1. 在 profile 目录执行 pnpm add -w ${packageRoot}`)
if (!alreadyBundled) console.log(`   ${alreadyDependency ? 1 : 2}. 把 ${packageName} 写入 dsh.profile.bundles`)
console.log('   备份 package.json（写成 package.json.bak-<时间戳>）')
console.log('')

if (options.dryRun) {
  console.log('（dry-run，未做任何修改）')
  process.exit(0)
}

if (options.profile === 'desktop' && !ensureDesktopClosed()) process.exit(1)

// 备份先行，任何后续失败都可以手工回滚。
const backupPath = `${profileManifestPath}.bak-${Date.now()}`
copyFileSync(profileManifestPath, backupPath)
console.log(`已备份：${backupPath}`)

if (!alreadyDependency) {
  // 与官方文档一致：profile 目录本身是一个 pnpm workspace，必须带 -w。
  const code = run('pnpm', ['add', '-w', packageRoot], profileDir)
  if (code !== 0) {
    console.error('❌ pnpm add 失败。本次未修改 dsh.profile.bundles。')
    console.error(`   可执行 pnpm remove -w ${packageName} 回滚依赖安装。`)
    process.exit(code)
  }
}

// 重新读取：pnpm 会重写 package.json，必须以磁盘上的最新内容为准。
const updated = readManifest(profileManifestPath)
const updatedBundles = readBundles(updated)
if (!updatedBundles.includes(packageName)) {
  updated.dsh = updated.dsh ?? {}
  updated.dsh.profile = updated.dsh.profile ?? {}
  updated.dsh.profile.bundles = [...updatedBundles, packageName]
  writeManifest(profileManifestPath, updated)
  console.log(`已把 ${packageName} 写入 dsh.profile.bundles`)
}

console.log('')
console.log('✅ 安装完成。接下来：')
console.log('   1. 重新打开 DeepSeek Harness Desktop')
console.log('   2. 在侧边栏 Plugins 页面确认 dsh-ralph 已启用')
console.log('   3. 在目标项目目录准备 prd.json，然后执行 /ralph')
