/**
 * 体检：一次性回答「为什么 Blender MCP 用不了」。
 *
 * 这个模块存在的理由：MCP 客户端连不上 Blender 时的默认表现是**工具列表为空**，
 * 没有任何提示。用户无从判断是 Blender 没开、插件没启用、端口被占，还是包没装。
 * 因此这里把可观察事实逐项摊开，并给出唯一一条最可能的下一步动作。
 *
 * 本模块全部为只读操作，不写入 Blender 目录、不修改偏好设置。
 */

import { createConnection } from 'node:net'

import { classifyAddon, describeBundledAddon, describeInstalledAddon } from './addon.mjs'
import { formatVersion, resolveBlender } from './resolve.mjs'

/** 插件默认监听的端口；与上游 `blender_mcp.py` 的 `default=9876` 一致。 */
export const DEFAULT_PORT = 9876
/** 插件默认绑定的主机。 */
export const DEFAULT_HOST = 'localhost'

/**
 * 从 socket 错误里提取一条人类可读的原因。
 *
 * Node 在 Windows 上把连接拒绝包装成 `AggregateError`，它的 `message` 是空串，
 * 真正的原因在 `errors[0]` 上。直接取 `message` 会得到空白提示，等于没报错，
 * 因此这里显式下钻。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {string} 可读的原因文本。
 */
function describeSocketError(error) {
  if (error instanceof AggregateError) {
    const inner = Array.isArray(error.errors) ? error.errors : []
    for (const candidate of inner) {
      const text = describeSocketError(candidate)
      if (text) return text
    }
    return '连接被拒绝'
  }
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null
    const message = 'message' in error && typeof error.message === 'string' ? error.message.trim() : ''
    if (message) return code ? `${code}: ${message}` : message
    if (code) return code
  }
  const text = String(error ?? '').trim()
  return text === '[object Object]' ? '' : text
}

/**
 * 探测 TCP 端口是否有进程在监听。
 *
 * @param {object} options 选项。
 * @param {string} [options.host] 主机。
 * @param {number} [options.port] 端口。
 * @param {number} [options.timeoutMs] 连接超时。
 * @returns {Promise<boolean>} 有监听时为 true。
 */
export function probePort({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    /** 无论成功或失败都只结算一次，并确保套接字被释放。 */
    const settle = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * 判断一条错误回复是否来自 Blender 插件本身（而不是占了同端口的其他程序）。
 *
 * 上游插件对无法识别的命令回固定文案 `Unknown command type: <type>`。这条文案
 * 是「对端确实是插件、只是版本较老」的可靠指纹，因此可以据此给出准确结论，
 * 而不是误报成端口冲突。
 *
 * @param {string | null} message 回复里的错误消息。
 * @returns {boolean} 像 Blender 插件的回复时为 true。
 */
function looksLikeAddonError(message) {
  return typeof message === 'string' && /^Unknown command type:/i.test(message.trim())
}

/**
 * 与插件做一次真实协议握手，确认对端确实是 Blender 插件而不只是占了端口。
 *
 * 首选 `ping`：上游把它定义为不触碰任何 bpy 数据的存活检测，因此是最安全也最
 * 稳定的连通性探针。若对端回「无法识别的命令」，说明是更老的插件版本——那同样
 * 证明了对端身份，只是缺这个命令，因此单独归类为 `addon-too-old` 而不是端口冲突。
 *
 * 注意上游 README 写的 `get_addon_status` 在插件里并不存在（实际命令名是
 * `get_addon_info`），所以这里只依赖 `ping` 与错误文案这两个稳定信号。
 *
 * @param {object} options 选项。
 * @param {string} [options.host] 主机。
 * @param {number} [options.port] 端口。
 * @param {number} [options.timeoutMs] 单次读写超时。
 * @returns {Promise<object>} 含 `ok`、`status`、`result`、`error`、`identity` 的结果。
 */
export function handshake({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let buffer = ''
    let settled = false

    /** 收尾：只结算一次，避免 error/end/timeout 竞态导致重复 resolve。 */
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(JSON.stringify({ type: 'ping', params: {} }))
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      try {
        const payload = JSON.parse(buffer)
        const ok = payload.status === 'success'
        finish({
          ok,
          status: payload.status ?? null,
          result: payload.result ?? null,
          error: payload.message ?? null,
          identity: ok ? 'addon' : looksLikeAddonError(payload.message) ? 'addon-too-old' : 'unknown',
        })
      } catch {
        // 分片未收全，继续累积直到超时。
      }
    })
    socket.once('timeout', () => finish({ ok: false, status: null, result: null, error: `握手超时（${timeoutMs}ms）`, identity: 'unknown' }))
    socket.once('error', (error) => finish({ ok: false, status: null, result: null, error: describeSocketError(error), identity: 'unknown' }))
    socket.once('end', () => finish({ ok: false, status: null, result: null, error: '连接被对端关闭，未返回数据', identity: 'unknown' }))
  })
}

/** 各诊断结论对应的下一步动作，集中一处便于保持措辞一致。 */
const NEXT_ACTION = {
  'no-blender': '未在本机找到 Blender。请安装 Blender，或用 --blender <路径> 指定可执行文件。',
  'no-addon': 'Blender 插件尚未安装。运行 `dsh-blender-mcp install-addon` 安装后重启 Blender。',
  'addon-outdated': 'Blender 插件版本落后于本包自带版本。运行 `dsh-blender-mcp install-addon` 更新后重启 Blender。',
  'addon-too-old': '端口上的 Blender 插件版本过旧（缺少 ping 命令）。运行 `dsh-blender-mcp install-addon` 更新插件并重启 Blender。',
  'blender-closed': '插件已就位，但端口无人监听——请打开 Blender。插件默认会自动启动服务；若未启动，在 3D 视图按 N，打开「MCP for Blender」面板点 Start MCP Server。',
  'port-conflict': '端口被非 Blender 程序占用。请在 Blender 插件面板改用其他端口，并同步修改本包的 MCP 服务端配置（--port）。',
  'protocol-error': '端口有响应但不是预期的 Blender 插件协议，请确认该端口由 Blender 插件提供。',
  ok: '连接正常，可以直接让模型操作 Blender。',
}

/**
 * 执行一次完整体检。
 *
 * 检查项按「越靠前越可能是根因」的顺序短路：没有 Blender 就无需报告端口状态，
 * 没装插件就不必探测 socket。这样输出的第一条永远是最值得处理的那条。
 *
 * @param {object} [options] 选项。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量来源。
 * @param {string} [options.executable] 显式指定的 Blender 可执行文件。
 * @param {number} [options.port] 插件端口。
 * @param {string} [options.host] 插件主机。
 * @param {boolean} [options.probe] 是否允许启动 Blender 做自报告探测。
 * @param {number} [options.timeoutMs] 探测超时。
 * @param {boolean} [options.deep] 端口有监听时是否做协议握手。
 * @returns {Promise<object>} 体检报告。
 */
export async function runDoctor({
  env = process.env,
  executable,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  probe = true,
  timeoutMs,
  deep = true,
} = {}) {
  const checks = []
  const bundled = await describeBundledAddon()

  const blender = await resolveBlender({ env, executable, probe, timeoutMs })
  if (!blender.addonsDir) {
    checks.push({
      name: 'blender',
      status: 'fail',
      detail: '未定位到 Blender 的插件目录。',
    })
    return {
      state: 'no-blender',
      ok: false,
      summary: '未找到 Blender',
      nextAction: NEXT_ACTION['no-blender'],
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: null,
      socket: null,
      notes: blender.notes,
    }
  }

  checks.push({
    name: 'blender',
    status: 'pass',
    detail: `Blender ${blender.version ?? '未知版本'}，插件目录经 ${blender.source} 解析：${blender.addonsDir}`,
  })

  const addon = await describeInstalledAddon(blender.addonsDir)
  const relation = classifyAddon(bundled, addon)
  const addonSummary = {
    installed: addon.installed,
    version: addon.versionText,
    path: addon.path,
    relation,
    matchesBundled: addon.matchesBundled,
  }

  if (!addon.installed) {
    checks.push({ name: 'addon', status: 'fail', detail: `未安装（期望 ${bundled.versionText}）：${addon.path}` })
    return {
      state: 'no-addon',
      ok: false,
      summary: 'Blender 插件未安装',
      nextAction: NEXT_ACTION['no-addon'],
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: addonSummary,
      socket: null,
      notes: blender.notes,
    }
  }

  checks.push({
    name: 'addon',
    status: relation === 'outdated' || relation === 'diverged' ? 'warn' : 'pass',
    detail: `已安装 ${addon.versionText}${addon.matchesBundled ? '（与本包自带一致）' : `（本包自带 ${bundled.versionText}）`}`,
  })

  if (relation === 'outdated') {
    return {
      state: 'addon-outdated',
      ok: false,
      summary: `插件版本落后：已装 ${addon.versionText}，自带 ${bundled.versionText}`,
      nextAction: NEXT_ACTION['addon-outdated'],
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: addonSummary,
      socket: null,
      notes: blender.notes,
    }
  }

  const listening = await probePort({ host, port })
  if (!listening) {
    checks.push({ name: 'socket', status: 'fail', detail: `${host}:${port} 无监听` })
    return {
      state: 'blender-closed',
      ok: false,
      summary: `插件已安装（${addon.versionText}），但 ${host}:${port} 无人监听——通常是 Blender 没打开`,
      nextAction: NEXT_ACTION['blender-closed'],
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: addonSummary,
      socket: { listening: false, host, port },
      notes: blender.notes,
    }
  }

  if (!deep) {
    checks.push({ name: 'socket', status: 'pass', detail: `${host}:${port} 有监听（未做协议握手）` })
    return {
      state: 'ok',
      ok: true,
      summary: `Blender 插件在 ${host}:${port} 监听中`,
      nextAction: NEXT_ACTION.ok,
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: addonSummary,
      socket: { listening: true, host, port, handshake: null },
      notes: blender.notes,
    }
  }

  const result = await handshake({ host, port })
  const handshakeSummary = { ok: result.ok, identity: result.identity, error: result.error, addonVersion: null }
  const rawVersion = result.result?.addon_version
  if (Array.isArray(rawVersion)) handshakeSummary.addonVersion = formatVersion(rawVersion)

  if (!result.ok) {
    // 「无法识别的命令」证明对端是更老的插件，而不是别的程序抢了端口——这两种
    // 情况的处置完全不同，必须分开报。
    const tooOld = result.identity === 'addon-too-old'
    checks.push({
      name: 'socket',
      status: 'fail',
      detail: tooOld
        ? `端口上确实有 Blender 插件，但它不认识 ping 命令（${result.error}）`
        : `端口有监听但握手失败：${result.error ?? '未知原因'}`,
    })
    return {
      state: tooOld ? 'addon-too-old' : 'port-conflict',
      ok: false,
      summary: tooOld
        ? `${host}:${port} 上的 Blender 插件版本过旧，缺少 ping 命令`
        : `${host}:${port} 被占用，但对端不是 Blender 插件`,
      nextAction: tooOld ? NEXT_ACTION['addon-too-old'] : NEXT_ACTION['port-conflict'],
      checks,
      blender,
      bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
      addon: addonSummary,
      socket: { listening: true, host, port, handshake: handshakeSummary },
      notes: blender.notes,
    }
  }

  checks.push({
    name: 'socket',
    status: 'pass',
    detail: `${host}:${port} 握手成功（ping -> pong${handshakeSummary.addonVersion ? `，插件自报 ${handshakeSummary.addonVersion}` : ''}）`,
  })
  return {
    state: 'ok',
    ok: true,
    summary: `连接正常：Blender 插件 ${addon.versionText} 响应于 ${host}:${port}`,
    nextAction: NEXT_ACTION.ok,
    checks,
    blender,
    bundled: { version: bundled.versionText, path: bundled.path, exists: bundled.exists },
    addon: addonSummary,
    socket: { listening: true, host, port, handshake: handshakeSummary },
    notes: blender.notes,
  }
}

/**
 * 把体检报告渲染成模型可读的多行文本。
 *
 * @param {object} report `runDoctor` 的返回值。
 * @returns {string} 报告文本。
 */
export function formatReport(report) {
  const lines = [`Blender MCP 体检：${report.ok ? '通过' : '需要处理'} — ${report.summary}`]
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'FAIL'
    lines.push(`  [${mark}] ${check.name}: ${check.detail}`)
  }
  lines.push(`  下一步：${report.nextAction}`)
  if (report.notes?.length) {
    for (const note of report.notes) lines.push(`  说明：${note}`)
  }
  return lines.join('\n')
}

export { DEFAULT_PORT as PORT }
