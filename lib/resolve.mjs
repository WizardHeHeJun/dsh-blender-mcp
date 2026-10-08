/**
 * Blender 定位：找出 Blender 可执行文件，并解析它真实的用户配置根目录。
 *
 * 为什么不让调用方猜路径：Blender 的用户配置根随安装形态变化，同一个版本号
 * 至少有三种落点，且仅凭文件系统探测无法区分「尚未创建」与「在别处」。
 *
 * - 装机版（MSI / 安装程序）：`%APPDATA%\Blender Foundation\Blender\<版本>`
 * - 绿色版但配置未被创建：Blender 回退到上述同一个用户目录
 * - 绿色版且自带配置：`<安装目录>\<版本>\config`（端口式安装）
 *
 * `addon-paths` 一类纯猜测工具因此可能报出一个 Blender 实际不读的目录。本模块
 * 的首选策略是**让 Blender 自己报告**（`--background --python-expr`，本机实测
 * 约 1 秒），失败时才退回显式覆盖与按已知布局探测。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 探测脚本要求 Blender 回传的机器可读前缀。 */
const PROBE_MARKER = 'DSH_BLENDER_PROBE '

/**
 * 让 Blender 打印自己真实使用的配置/脚本/插件目录与版本。
 *
 * 用 `--python-expr` 而不是临时脚本文件，避免在用户磁盘上留下残留；两个
 * `user_resource()` 调用是 Blender 判定端口的同一份逻辑，因此结果权威。
 */
const PROBE_EXPR = [
  'import bpy, json',
  'print(' + JSON.stringify(PROBE_MARKER) + ' + json.dumps({',
  '  "version": bpy.app.version_string,',
  '  "config": bpy.utils.user_resource("CONFIG"),',
  '  "scripts": bpy.utils.user_resource("SCRIPTS"),',
  '  "addons": bpy.utils.user_resource("SCRIPTS", path="addons"),',
  '}))',
].join('\n')

/** 探测 Blender 的默认超时；绿色版冷启动实测约 1 秒，留足余量。 */
const DEFAULT_PROBE_TIMEOUT_MS = 30000

/**
 * 把 Blender 版本串解析成可比较的数字元组。
 *
 * 同时接受 `"4.5.14 LTS"`（`bpy.app.version_string`）与 `"4.5"`（目录名）：
 * 缺失的位补 0，因此 `4.5` 等于 `4.5.0`，符合 Blender 自己的语义。
 *
 * @param {unknown} value 形如 `4.5.14 LTS` / `4.5` / `4.5.0` 的值。
 * @returns {number[] | null} 版本元组，无法解析时为 null。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+(?:\.\d+)*)/)
  if (!match) return null
  return match[1].split('.').map((part) => Number.parseInt(part, 10))
}

/**
 * 比较两个版本元组。
 *
 * @param {number[]} a 左值。
 * @param {number[]} b 右值。
 * @returns {number} a 小于、等于、大于 b 时分别为负数、0、正数。
 */
export function compareVersions(a, b) {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * 把版本元组还原成 `4.5.14` 这样的显示串。
 *
 * @param {number[] | null} version 版本元组。
 * @returns {string} 显示用版本串，缺失时为 `unknown`。
 */
export function formatVersion(version) {
  return version ? version.join('.') : 'unknown'
}

/**
 * 报告一个插件目录是否像 Blender 的脚本目录。
 *
 * 判定标准是「存在名为 addons 的子目录」，因为这才是插件要写进去的位置；
 * 只认目录名会把 `.../scripts` 与其父目录混为一谈。
 *
 * @param {string} scriptsRoot 候选脚本目录。
 * @returns {boolean} 是脚本目录时为 true。
 */
function looksLikeScriptsRoot(scriptsRoot) {
  try {
    return statSync(join(scriptsRoot, 'addons')).isDirectory()
  } catch {
    return false
  }
}

/**
 * 列出目录下看起来像版本号的子目录名，按版本升序。
 *
 * @param {string} parent 父目录。
 * @returns {string[]} 形如 `4.5` 的版本目录名。
 */
function listVersionDirs(parent) {
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(parseVersion(a) ?? [], parseVersion(b) ?? []))
}

/**
 * 按 Blender 已知的目录布局探测配置根，作为无法执行 Blender 时的回退。
 *
 * 覆盖三类落点：用户目录（装机版与未创建配置的绿色版共用）、`LOCALAPPDATA`
 * 下的按用户安装，以及自带 `config` 子目录的端口式安装。只返回确实像 Blender
 * 脚本目录的候选——宁可不报，也不给出一个 Blender 不会读的路径。
 *
 * @param {object} [options] 覆盖项。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源，默认 `process.env`。
 * @param {string} [options.launcherPath] 已知的 Blender 可执行文件路径。
 * @returns {Array<{configRoot: string, addonsDir: string, source: string, version: string|null}>} 候选配置根。
 */
export function discoverConfigRoots({ env = process.env, launcherPath } = {}) {
  const found = []
  const seen = new Set()

  /** 记录一个候选，重复路径只保留首次出现（首次来源信息更有意义）。 */
  const push = (scriptsRoot, source, version) => {
    if (!looksLikeScriptsRoot(scriptsRoot)) return
    const addonsDir = join(scriptsRoot, 'addons')
    if (seen.has(addonsDir)) return
    seen.add(addonsDir)
    found.push({
      configRoot: scriptsRoot.replace(/[\\/]scripts$/, ''),
      addonsDir,
      source,
      version: version ?? null,
    })
  }

  // 1. 用户级根：装机版与「绿色版但未创建自带配置」都落在这里。
  if (env.APPDATA) {
    const userRoot = join(env.APPDATA, 'Blender Foundation', 'Blender')
    for (const version of listVersionDirs(userRoot)) {
      push(join(userRoot, version, 'scripts'), 'user-appdata', version)
    }
  }

  // 2. 按用户安装根（Windows 上的 winget / 用户级安装）。
  if (env.LOCALAPPDATA) {
    const localRoot = join(env.LOCALAPPDATA, 'Programs', 'Blender Foundation', 'Blender')
    for (const version of listVersionDirs(localRoot)) {
      push(join(localRoot, version, 'scripts'), 'user-localappdata', version)
    }
  }

  // 3. 端口式安装：自带 config/scripts 的绿色版。版本目录用大版本号，未知时
  //    枚举安装目录下的版本号子目录。
  if (launcherPath) {
    const installRoot = launcherPath.replace(/[\\/][^\\/]+$/, '')
    const candidates = []
    for (const version of listVersionDirs(installRoot)) {
      candidates.push({ dir: join(installRoot, version), version })
    }
    candidates.push({ dir: installRoot, version: null })
    for (const candidate of candidates) {
      push(join(candidate.dir, 'scripts'), 'portable', candidate.version)
    }
  }

  return found
}

/**
 * 在常见位置寻找 Blender 可执行文件，供自动探测使用。
 *
 * 顺序即优先级：显式环境变量最可信，其次是 PATH 解析，最后是各平台的常见
 * 安装目录。找到即返回，不做穷举。
 *
 * @param {object} [options] 覆盖项。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源，默认 `process.env`。
 * @returns {string | null} 可执行文件绝对路径，未找到时为 null。
 */
export function findBlenderExecutable({ env = process.env } = {}) {
  const fromEnv = env.DSH_BLENDER_EXECUTABLE
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const names = process.platform === 'win32' ? ['blender.exe'] : ['blender']
  const suffixes = process.platform === 'darwin'
    ? ['', 'Contents/MacOS/Blender']
    : ['']

  for (const dir of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }

  const roots = []
  if (process.platform === 'win32') {
    if (env.ProgramFiles) roots.push(join(env.ProgramFiles, 'Blender Foundation'))
    if (env['ProgramFiles(x86)']) roots.push(join(env['ProgramFiles(x86)'], 'Blender Foundation'))
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'Blender Foundation'))
  } else if (process.platform === 'darwin') {
    roots.push('/Applications')
  } else {
    roots.push('/usr/share', '/usr/local', join(homedir(), '.local'))
  }

  for (const root of roots) {
    for (const version of listVersionDirs(root)) {
      for (const suffix of suffixes) {
        const candidate = join(root, version, suffix ? join('Blender.app', suffix) : names[0])
        if (existsSync(candidate)) return candidate
      }
    }
  }

  // 自装的绿色版常常落在驱动器根目录下（如 D:\Blender），既不在 PATH 也没有
  // 注册表记录。只扫描根目录一层，按固定名字命中，代价可控且不会误判。
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      for (const folder of ['Blender', 'blender', 'Blender Foundation']) {
        const candidate = join(`${drive}\\`, folder, names[0])
        if (existsSync(candidate)) return candidate
      }
    }
  }

  return null
}

/**
 * 启动 Blender 一次，让它报告自己真实使用的配置目录。
 *
 * 这是首选策略：结果权威且覆盖所有安装形态。失败（未安装、超时、输出异常）
 * 一律返回 null，由调用方回退到静态探测，不向上抛错——定位失败本身是体检的
 * 结论之一，不是异常。
 *
 * @param {object} options 选项。
 * @param {string} options.executable Blender 可执行文件路径。
 * @param {number} [options.timeoutMs] 探测超时。
 * @param {NodeJS.ProcessEnv} [options.env] 子进程环境。
 * @returns {Promise<object | null>} 探测结果，失败时为 null。
 */
export async function probeBlender({ executable, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, env = process.env }) {
  try {
    const { stdout } = await execFileAsync(
      executable,
      ['--background', '--factory-startup', '--python-expr', PROBE_EXPR],
      { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    )
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.includes(PROBE_MARKER))
    if (!line) return null
    const payload = JSON.parse(line.slice(line.indexOf(PROBE_MARKER) + PROBE_MARKER.length))
    if (!payload.addons) return null
    return {
      version: payload.version ?? null,
      parsedVersion: parseVersion(payload.version),
      configDir: payload.config ?? null,
      scriptsDir: payload.scripts ?? null,
      addonsDir: payload.addons,
    }
  } catch {
    return null
  }
}

/**
 * 解析本次要使用的 Blender 配置根，按可信度依次尝试。
 *
 * @param {object} [options] 选项。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源。
 * @param {string} [options.executable] 显式指定的 Blender 可执行文件。
 * @param {boolean} [options.probe] 是否允许启动 Blender 探测。
 * @param {number} [options.timeoutMs] 探测超时。
 * @returns {Promise<object>} 含 `addonsDir`、`source`、`version`、`notes` 的解析结果。
 */
export async function resolveBlender({ env = process.env, executable, probe = true, timeoutMs } = {}) {
  const notes = []
  const explicit = executable ?? findBlenderExecutable({ env })

  if (!explicit) {
    notes.push('未找到 Blender 可执行文件，已跳过自报告探测；请用 --blender 指定路径。')
  } else if (probe) {
    const probed = await probeBlender({ executable: explicit, timeoutMs, env })
    if (probed) {
      return {
        addonsDir: probed.addonsDir,
        configDir: probed.configDir,
        scriptsDir: probed.scriptsDir,
        version: probed.version,
        parsedVersion: probed.parsedVersion,
        source: 'probe',
        executable: explicit,
        notes,
      }
    }
    notes.push(`启动 ${explicit} 探测失败，已回退到按已知布局探测。`)
  }

  const candidates = discoverConfigRoots({ env, launcherPath: explicit ?? undefined })
  if (candidates.length === 0) {
    notes.push('未在任何已知位置找到 Blender 的插件目录。')
    return { addonsDir: null, version: null, parsedVersion: null, source: 'none', executable: explicit, notes }
  }

  // 多个候选时选版本最高的：用户升级后旧版本目录常常残留。
  const best = candidates.reduce((winner, candidate) => {
    const winnerVersion = parseVersion(winner.version ?? '') ?? []
    const candidateVersion = parseVersion(candidate.version ?? '') ?? []
    return compareVersions(candidateVersion, winnerVersion) > 0 ? candidate : winner
  })

  return {
    addonsDir: best.addonsDir,
    configDir: best.configRoot,
    scriptsDir: join(best.configRoot, 'scripts'),
    version: best.version,
    parsedVersion: parseVersion(best.version ?? ''),
    source: best.source,
    executable: explicit,
    notes,
  }
}

/** 导出内部常量，便于测试与调用方复用同一份判定。 */
export const internals = { PROBE_MARKER, PROBE_EXPR, looksLikeScriptsRoot, listVersionDirs }
