#!/usr/bin/env node
/**
 * 从上游 `mcp-for-blender` 同步内嵌的 Blender 侧插件。
 *
 * 本包内嵌的是上游产物的一份快照（上游把插件放在 Python 包的
 * `blender_mcp/bundled/addon.py`）。上游发新版后运行本脚本即可更新，无需手工
 * 下载与替换。
 *
 * 用法：
 *   node scripts/sync-addon.mjs            # 同步
 *   node scripts/sync-addon.mjs --check    # 只对比，不写入；有差异时退出码 1
 */

import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { BUNDLED_ADDON_PATH, describeBundledAddon, hashFile, parseAddonInfo } from '../lib/addon.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 上游在 Python 包里存放插件文件的相对路径。 */
const UPSTREAM_ADDON_RELATIVE = join('blender_mcp', 'bundled', 'addon.py')

/**
 * 用 uv 拉取上游包，并返回其包根目录。
 *
 * 选 uv 而不是 pip：`uv pip install` 不必先建虚拟环境，且本机已确认可用（
 * MCP 服务端本身就靠 uvx 运行）。
 *
 * @param {string} version 版本号或 `latest`。
 * @param {string} target 安装目标目录。
 * @returns {Promise<{addonPath: string, resolvedVersion: string}>} 上游插件文件路径与实际版本。
 */
async function fetchUpstream(version, target) {
  const spec = version === 'latest' ? 'mcp-for-blender' : `mcp-for-blender==${version}`
  await execFileAsync('uv', ['pip', 'install', '--target', target, '--no-deps', spec], {
    timeout: 180000,
  })

  // UPSTREAM_ADDON_RELATIVE 相对 --target 根目录（形如 blender_mcp/bundled/addon.py），
  // 因此直接拼在 target 上，不要再套一层包目录。
  const addonPath = join(target, UPSTREAM_ADDON_RELATIVE)
  if (!existsSync(addonPath)) {
    throw new Error(`上游包里没找到 ${UPSTREAM_ADDON_RELATIVE}，可能上游改了布局。`)
  }

  // 版本以实际安装为准，而不是请求值：从 dist-info 目录名读取最可靠。
  let resolvedVersion = version
  const distInfo = (await readdir(target)).find((name) => name.endsWith('.dist-info'))
  if (distInfo) {
    try {
      const metadata = await readFile(join(target, distInfo, 'METADATA'), 'utf8')
      const match = metadata.match(/^Version:\s*(.+)$/m)
      if (match) resolvedVersion = match[1].trim()
    } catch {
      // METADATA 读取失败不影响同步，只是版本号回退为请求值。
    }
  }

  return { addonPath, resolvedVersion }
}

/**
 * 同步主流程。
 *
 * @returns {Promise<void>} 结束时设置退出码。
 */
async function main() {
  const checkOnly = process.argv.includes('--check')
  const versionArg = process.argv.find((arg) => arg.startsWith('--version='))
  const version = versionArg ? versionArg.slice('--version='.length) : 'latest'

  const before = await describeBundledAddon()
  console.log(`当前内嵌插件：${before.versionText}（${BUNDLED_ADDON_PATH}）`)

  const staging = await mkdtemp(join(tmpdir(), 'dsh-blender-mcp-sync-'))
  try {
    console.log(`拉取上游 mcp-for-blender（${version}）...`)
    const { addonPath, resolvedVersion } = await fetchUpstream(version, staging)
    const source = await readFile(addonPath, 'utf8')
    const upstreamInfo = parseAddonInfo(source)
    const upstreamHash = await hashFile(addonPath)

    console.log(`上游包版本：${resolvedVersion}`)
    console.log(`上游插件版本：${upstreamInfo.version ? upstreamInfo.version.join('.') : '未知'}（${upstreamInfo.name ?? '未命名'}）`)

    if (upstreamHash === before.sha256) {
      console.log('内容一致，无需同步。')
      return
    }

    if (checkOnly) {
      console.error('检测到差异（--check 模式，未写入）。运行不带 --check 的命令以同步。')
      process.exitCode = 1
      return
    }

    await copyFile(addonPath, BUNDLED_ADDON_PATH)
    const after = await describeBundledAddon()
    console.log(`已同步到 ${after.versionText}，sha256 ${after.sha256?.slice(0, 12)}`)

    // 版本号要跟着一起走，否则 npm 上会出现「同名不同内容」，无法区分。
    const packageJsonPath = join(repoRoot, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    console.log(`提示：如为正式发布，请手动更新 package.json 版本（当前 ${packageJson.version}）与 PROVENANCE.md 记录。`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  console.error(`同步失败：${error?.message ?? String(error)}`)
  process.exitCode = 1
})
