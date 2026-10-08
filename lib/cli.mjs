#!/usr/bin/env node
/**
 * dsh-blender-mcp 命令行。
 *
 * 为什么安装 Blender 侧插件是一个命令行动作、而不是模型工具：向 Blender 目录
 * 写文件属于运维行为，应当由人明确触发。模型能拿到的只有只读的
 * `blender_mcp_doctor`，因此不存在「模型自作主张重装插件」的路径。
 *
 * 本包自带上游插件文件，所以安装过程不需要 `uvx`，也不依赖上游安装器能否猜对
 * Blender 的插件目录。
 */

import { parseArgs } from 'node:util'

import { ADDON_LABEL, describeBundledAddon, describeInstalledAddon, installAddon } from './addon.mjs'
import { DEFAULT_HOST, DEFAULT_PORT, formatReport, runDoctor } from './doctor.mjs'
import { discoverConfigRoots, findBlenderExecutable, resolveBlender } from './resolve.mjs'

const USAGE = `dsh-blender-mcp —— DSH 的 Blender MCP 适配

用法：
  dsh-blender-mcp doctor           体检：Blender / 插件 / 端口逐项检查
  dsh-blender-mcp install-addon    把自带的 Blender 插件安装到 Blender
  dsh-blender-mcp paths            列出探测到的 Blender 插件目录

选项：
  --blender <路径>   指定 Blender 可执行文件（默认自动查找）
  --no-probe         不启动 Blender，仅按已知目录布局探测
  --port <端口>      Blender 插件端口（默认 ${DEFAULT_PORT}）
  --host <主机>      插件主机（默认 ${DEFAULT_HOST}）
  --force            即使内容一致也重新写入插件文件
  --json             以 JSON 输出（供脚本消费）
  -h, --help         显示本帮助
`

/**
 * 解析命令行，未知选项直接报错退出而不是忽略——静默忽略会让人以为选项生效了。
 *
 * @param {string[]} argv 不含 node 与脚本名的参数。
 * @returns {object} 解析结果。
 */
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      blender: { type: 'string' },
      'no-probe': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port 需要 1-65535 之间的整数，收到：${values.port}`)
  }
  return {
    command: positionals[0] ?? 'doctor',
    extra: positionals.slice(1),
    executable: values.blender,
    probe: !values['no-probe'],
    port,
    host: values.host ?? DEFAULT_HOST,
    force: Boolean(values.force),
    json: Boolean(values.json),
    help: Boolean(values.help),
  }
}

/**
 * 执行 doctor 子命令。
 *
 * @param {object} options 解析后的选项。
 * @returns {Promise<number>} 进程退出码：可正常使用为 0，需要处理为 1。
 */
async function commandDoctor(options) {
  const report = await runDoctor({
    executable: options.executable,
    probe: options.probe,
    host: options.host,
    port: options.port,
  })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(report)}\n`)
  }
  return report.ok ? 0 : 1
}

/**
 * 执行 install-addon 子命令。
 *
 * @param {object} options 解析后的选项。
 * @returns {Promise<number>} 进程退出码。
 */
async function commandInstallAddon(options) {
  const blender = await resolveBlender({ executable: options.executable, probe: options.probe })
  const bundled = await describeBundledAddon()

  if (!bundled.exists) {
    process.stderr.write(`本包缺少自带的 Blender 插件文件：${bundled.path}\n`)
    return 1
  }
  if (!blender.addonsDir) {
    process.stderr.write('未能定位 Blender 的插件目录。\n')
    for (const note of blender.notes) process.stderr.write(`  ${note}\n`)
    process.stderr.write('请用 --blender <路径> 指定 Blender 可执行文件后重试。\n')
    return 1
  }

  const result = await installAddon({ addonsDir: blender.addonsDir, force: options.force })
  const output = {
    action: result.action,
    reason: result.reason,
    target: result.target ?? null,
    backupPath: result.backupPath ?? null,
    addonsDir: blender.addonsDir,
    source: blender.source,
    blenderVersion: blender.version,
    bundledVersion: bundled.versionText,
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.reason}\n`)
    process.stdout.write(`  目标目录：${blender.addonsDir}（经 ${blender.source} 解析）\n`)
    if (result.backupPath) process.stdout.write(`  原文件已备份为：${result.backupPath}\n`)
    if (result.action !== 'unchanged') {
      process.stdout.write(`  下一步：重启 Blender，然后在 编辑 → 偏好设置 → 插件 里确认「${ADDON_LABEL}」已启用。\n`)
    }
  }
  return result.action === 'skipped' ? 1 : 0
}

/**
 * 执行 paths 子命令：列出探测到的插件目录及其已装插件状态。
 *
 * @param {object} options 解析后的选项。
 * @returns {Promise<number>} 进程退出码。
 */
async function commandPaths(options) {
  const executable = options.executable ?? findBlenderExecutable()
  const candidates = discoverConfigRoots({ launcherPath: executable ?? undefined })
  const rows = []
  for (const candidate of candidates) {
    const installed = await describeInstalledAddon(candidate.addonsDir)
    rows.push({
      addonsDir: candidate.addonsDir,
      source: candidate.source,
      version: candidate.version,
      addonInstalled: installed.installed,
      addonVersion: installed.versionText,
    })
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ executable, candidates: rows }, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`Blender 可执行文件：${executable ?? '未找到（用 --blender 指定）'}\n`)
  if (rows.length === 0) {
    process.stdout.write('未探测到任何 Blender 插件目录。\n')
    process.stdout.write('提示：`doctor` 会启动一次 Blender 来获取权威路径，比本命令的静态探测更准。\n')
    return 1
  }
  for (const row of rows) {
    process.stdout.write(
      `  ${row.addonsDir}\n    来源=${row.source} Blender版本=${row.version ?? '未知'} 插件=${
        row.addonInstalled ? `已装 ${row.addonVersion}` : '未装'
      }\n`,
    )
  }
  return 0
}

/**
 * 命令行入口。
 *
 * @returns {Promise<void>} 结束时设置进程退出码。
 */
async function main() {
  let options
  try {
    options = parse(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (options.help || options.command === 'help') {
    process.stdout.write(USAGE)
    return
  }

  try {
    switch (options.command) {
      case 'doctor':
        process.exitCode = await commandDoctor(options)
        return
      case 'install-addon':
        process.exitCode = await commandInstallAddon(options)
        return
      case 'paths':
        process.exitCode = await commandPaths(options)
        return
      default:
        process.stderr.write(`未知子命令：${options.command}\n\n${USAGE}`)
        process.exitCode = 2
    }
  } catch (error) {
    process.stderr.write(`执行失败：${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}

await main()
