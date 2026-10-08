/**
 * dsh-blender-mcp —— DSH 侧的 Blender MCP 一键适配插件。
 *
 * 它做两件事：
 *
 * 1. 通过本包的 bundle patch 声明式注册 MCP 服务端（见 `cordis.patch.yml`），
 *    让模型直接获得 `mcp__blender__*` 系列工具。
 * 2. 注册一个只读体检工具 `blender_mcp_doctor`，把「为什么连不上」的答案
 *    一次说清——不注册任何会写入磁盘的工具。
 *
 * Blender 侧插件的安装与更新是运维动作，由本包的命令行提供
 * （`dsh-blender-mcp install-addon`），刻意不暴露给模型，避免无意的覆盖写入。
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DEFAULT_HOST, DEFAULT_PORT, formatReport, runDoctor } from './doctor.mjs'

/** 插件名，同时是 loader 里可寻址的稳定标识。 */
export const name = 'blender-mcp'

/**
 * 依赖的工具注册表。本插件只注册一个自检工具，不依赖文件系统或子进程服务，
 * 因此在任何提供了 `ctx.tools` 的 profile 里都能加载（含 headless）。
 */
export const inject = ['tools']

/**
 * 插件配置：MCP 服务端连往哪个 Blender 插件端口。
 *
 * 仓库内的 `cordis.patch.yml` 把同样的默认值写给了 MCP 服务端配置；两处都改
 * 才能一起生效，这一点在 README 中明确说明。
 */
export const Config = Schema.object({
  host: Schema.string().default(DEFAULT_HOST).description('Blender 插件的监听主机。'),
  port: Schema.natural().default(DEFAULT_PORT).description('Blender 插件的监听端口。'),
  executable: Schema.string().default('').description('Blender 可执行文件路径；留空则自动查找。'),
  probe: Schema.boolean().default(true).description('是否允许启动一次 Blender 来获取它真实的插件目录（约 1 秒）。'),
})

/** 体检工具的描述：说明何时用、以及它只读这一关键约束。 */
const DOCTOR_DESCRIPTION = [
  '诊断 Blender MCP 连接状态，回答「为什么没有 mcp__blender__* 工具」。',
  '按由外到内的顺序检查：Blender 是否安装、Blender 侧插件是否安装且版本匹配、',
  '插件端口是否在监听、对端是否真的是 Blender 插件协议。',
  '返回逐项结论与唯一一条下一步动作。',
  '本工具完全只读：不安装插件、不修改 Blender 偏好设置、不写任何文件。',
  '当 mcp__blender__ 工具缺失或调用失败时先调用它；',
  '不要为了让工具出现而擅自改配置或重装，先看它的结论。',
].join('')

/**
 * 注册体检工具。
 *
 * @param {object} ctx Cordis 上下文，需提供 `ctx.tools`。
 * @param {object} config 已解析的插件配置。
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'blender_mcp_doctor',
    description: DOCTOR_DESCRIPTION,
    parameters: {
      deep: {
        type: 'boolean',
        description: '端口有监听时是否进一步做一次协议握手（默认 true）。握手只发送不触碰场景数据的只读 ping 命令。',
      },
      probe: {
        type: 'boolean',
        description: '是否允许启动一次 Blender 以获取它真实的插件目录（默认取插件配置，约 1 秒）。设为 false 则只按已知目录布局推断，可能给出不准确的路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '整体是否可直接使用。' },
          state: { type: 'string', required: true, description: '结论标识，如 ok / blender-closed / no-addon。' },
          summary: { type: 'string', required: true, description: '一句话结论。' },
          nextAction: { type: 'string', required: true, description: '唯一一条最值得执行的下一步。' },
          checks: {
            type: 'array',
            required: true,
            description: '逐项检查结果。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pass', 'warn', 'fail'] },
                detail: { type: 'string', required: true },
              },
            },
          },
          blender: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: 'Blender 定位结果。',
            properties: {
              executable: { type: 'string', description: '使用的可执行文件路径，未知时为空串。' },
              version: { type: 'string', description: 'Blender 版本串。' },
              addonsDir: { type: 'string', description: '解析到的插件目录。' },
              source: { type: 'string', required: true, description: '目录来源：probe / user-appdata / portable / none。' },
            },
          },
          addon: {
            // 未能定位 Blender 插件目录时该字段为 null，因此 schema 必须显式包含
            // null 分支——否则模型会以为它永远是对象，进而在 null 上取属性。
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                description: 'Blender 侧插件状态。',
                properties: {
                  installed: { type: 'boolean', required: true },
                  version: { type: 'string', required: true },
                  relation: { type: 'string', required: true, description: 'match / outdated / newer / diverged / missing。' },
                  path: { type: 'string' },
                },
              },
              { type: 'null', description: '未能定位 Blender 插件目录。' },
            ],
          },
          socket: {
            // 同上：未进行端口探测时为 null。
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                description: '端口状态。',
                properties: {
                  listening: { type: 'boolean', required: true },
                  host: { type: 'string', required: true },
                  port: { type: 'integer', required: true },
                  handshakeOk: { type: 'boolean', description: '协议握手是否成功。' },
                  handshakeError: { type: 'string', description: '握手失败原因。' },
                },
              },
              { type: 'null', description: '未进行端口探测。' },
            ],
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReport(value) }],
    },
    async execute(args) {
      const report = await runDoctor({
        host: config.host,
        port: config.port,
        executable: config.executable || undefined,
        probe: args.probe ?? config.probe,
        deep: args.deep ?? true,
      })

      // 归一到声明的输出 schema：省略可选字段而不是塞入 undefined，避免校验告警。
      const addon = report.addon
        ? {
            installed: report.addon.installed,
            version: report.addon.version,
            relation: report.addon.relation,
            path: report.addon.path ?? '',
          }
        : null
      const socket = report.socket
        ? {
            listening: report.socket.listening,
            host: report.socket.host,
            port: report.socket.port,
            handshakeOk: report.socket.handshake ? report.socket.handshake.ok : undefined,
            handshakeError: report.socket.handshake?.error ?? undefined,
          }
        : null
      return {
        ok: report.ok,
        state: report.state,
        summary: report.summary,
        nextAction: report.nextAction,
        checks: report.checks,
        blender: {
          executable: report.blender?.executable ?? '',
          version: report.blender?.version ?? 'unknown',
          addonsDir: report.blender?.addonsDir ?? '',
          source: report.blender?.source ?? 'none',
        },
        addon,
        socket,
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Blender MCP 体检',
      kind: 'other',
      rawInput: { host: config.host, port: config.port, executable: config.executable || null },
    }),
  }))
}
