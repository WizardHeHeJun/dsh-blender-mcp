/**
 * Blender 侧插件（addon）的安装、版本识别与校验。
 *
 * 本包自带一份 `blender_mcp.py`（与 `mcp-for-blender` 同一份上游产物），因此
 * 安装过程不依赖 `uvx`，也不依赖上游安装器能否猜对 Blender 的插件目录——目录
 * 由 `resolve.mjs` 让 Blender 自己报告。
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, formatVersion } from './resolve.mjs'

const require = createRequire(import.meta.url)
const libDir = dirname(fileURLToPath(import.meta.url))

/** 插件在 Blender 里的模块名；文件名必须与之一致才能被 Blender 找到。 */
export const ADDON_MODULE = 'blender_mcp'
/** 插件在 Blender 界面里的显示名，用于给用户指路。 */
export const ADDON_LABEL = 'MCP for Blender'
/** 本包自带的上游插件文件。 */
export const BUNDLED_ADDON_PATH = join(libDir, 'addon', `${ADDON_MODULE}.py`)

/**
 * 读取本包 `package.json` 里的版本号，用于对齐「自带的 Blender 插件」与包版本。
 *
 * @returns {string} 包版本。
 */
export function packageVersion() {
  return require('../package.json').version
}

/**
 * 从插件源码里解析 `bl_info` 的版本与显示名。
 *
 * Blender 用 `bl_info["version"]` 判断插件版本，所以这是判断「已装版本是否为
 * 本包自带的那一份」最可靠的依据，比文件哈希更能抵抗无关的格式差异。
 *
 * @param {string} source 插件源码文本。
 * @returns {{version: number[] | null, name: string | null}} 解析结果。
 */
export function parseAddonInfo(source) {
  const versionMatch = source.match(/["']version["']\s*:\s*\(([^)]*)\)/)
  const nameMatch = source.match(/["']name["']\s*:\s*["']([^"']+)["']/)
  let version = null
  if (versionMatch) {
    const parts = versionMatch[1]
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((part) => Number.isFinite(part))
    if (parts.length > 0) version = parts
  }
  return { version, name: nameMatch ? nameMatch[1] : null }
}

/**
 * 计算文件内容的 SHA-256，用于判断已装文件是否与本包自带的完全一致。
 *
 * @param {string} path 文件路径。
 * @returns {Promise<string | null>} 十六进制摘要，文件不存在时为 null。
 */
export async function hashFile(path) {
  try {
    const contents = await readFile(path)
    return createHash('sha256').update(contents).digest('hex')
  } catch {
    return null
  }
}

/**
 * 读取本包自带插件的版本信息。
 *
 * @returns {Promise<{path: string, exists: boolean, version: number[] | null, versionText: string, name: string | null, sha256: string | null}>} 自带插件信息。
 */
export async function describeBundledAddon() {
  const exists = existsSync(BUNDLED_ADDON_PATH)
  if (!exists) {
    return { path: BUNDLED_ADDON_PATH, exists: false, version: null, versionText: 'unknown', name: null, sha256: null }
  }
  const source = await readFile(BUNDLED_ADDON_PATH, 'utf8')
  const info = parseAddonInfo(source)
  return {
    path: BUNDLED_ADDON_PATH,
    exists: true,
    version: info.version,
    versionText: formatVersion(info.version),
    name: info.name,
    sha256: await hashFile(BUNDLED_ADDON_PATH),
  }
}

/**
 * 检查某个插件目录里的已装插件状态。
 *
 * @param {string | null} addonsDir Blender 插件目录。
 * @returns {Promise<object>} 含 `installed`、`version`、`matchesBundled` 等字段的状态。
 */
export async function describeInstalledAddon(addonsDir) {
  if (!addonsDir) {
    return { installed: false, path: null, version: null, versionText: 'unknown', name: null, sha256: null, matchesBundled: false, bytes: 0 }
  }
  const path = join(addonsDir, `${ADDON_MODULE}.py`)
  if (!existsSync(path)) {
    return { installed: false, path, version: null, versionText: 'unknown', name: null, sha256: null, matchesBundled: false, bytes: 0 }
  }
  const [source, bundled, sha256] = await Promise.all([
    readFile(path, 'utf8'),
    describeBundledAddon(),
    hashFile(path),
  ])
  const parsed = parseAddonInfo(source)
  let bytes = 0
  try {
    bytes = (await stat(path)).size
  } catch {
    bytes = 0
  }
  return {
    installed: true,
    path,
    version: parsed.version,
    versionText: formatVersion(parsed.version),
    name: parsed.name,
    sha256,
    bytes,
    matchesBundled: Boolean(sha256 && bundled.sha256 && sha256 === bundled.sha256),
  }
}

/**
 * 把本包自带的插件安装（或更新）到指定 Blender 插件目录。
 *
 * 已存在不同内容时先备份为 `.bak`，避免覆盖掉用户手改过的副本而无从恢复；
 * 内容一致时不做任何写入，使重复调用是幂等的。
 *
 * @param {object} options 选项。
 * @param {string | null} options.addonsDir 目标插件目录。
 * @param {boolean} [options.force] 即使内容一致也重新写入。
 * @returns {Promise<object>} 含 `action`（`installed`/`updated`/`unchanged`/`skipped`）、`backupPath` 的结果。
 */
export async function installAddon({ addonsDir, force = false }) {
  const bundled = await describeBundledAddon()
  if (!bundled.exists) {
    return { action: 'skipped', reason: `本包缺少自带插件文件：${BUNDLED_ADDON_PATH}`, backupPath: null }
  }
  if (!addonsDir) {
    return { action: 'skipped', reason: '未解析出 Blender 插件目录，无法安装。', backupPath: null }
  }

  await mkdir(addonsDir, { recursive: true })
  const target = join(addonsDir, `${ADDON_MODULE}.py`)
  const before = await describeInstalledAddon(addonsDir)

  if (before.installed && before.matchesBundled && !force) {
    return { action: 'unchanged', reason: `已是最新（插件 ${before.versionText}）。`, backupPath: null, target }
  }

  let backupPath = null
  if (before.installed) {
    backupPath = `${target}.bak`
    await copyFile(target, backupPath)
  }
  await copyFile(BUNDLED_ADDON_PATH, target)

  return {
    action: before.installed ? 'updated' : 'installed',
    reason: before.installed
      ? `已更新：插件 ${before.versionText} -> ${bundled.versionText}。`
      : `已安装插件 ${bundled.versionText}。`,
    backupPath,
    target,
  }
}

/**
 * 判定已装版本与自带版本的关系，供体检输出一句结论。
 *
 * @param {object} bundled 自带插件信息。
 * @param {object} installed 已装插件信息。
 * @returns {'missing' | 'match' | 'outdated' | 'newer' | 'diverged'} 关系结论。
 */
export function classifyAddon(bundled, installed) {
  if (!installed.installed) return 'missing'
  if (installed.matchesBundled) return 'match'
  if (!bundled.version || !installed.version) return 'diverged'
  const order = compareVersions(installed.version, bundled.version)
  if (order < 0) return 'outdated'
  if (order > 0) return 'newer'
  return 'diverged'
}
