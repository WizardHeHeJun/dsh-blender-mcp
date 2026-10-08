/**
 * 验证插件的注册契约与执行输出形态。
 *
 * 这里不启动 harness，而是用一个最小的假 ctx 捕获 `defineTool` 的产物——它正是
 * 注册到 `ctx.tools` 上的那个对象，因此能真实反映工具名、参数 schema、输出
 * schema 与渲染结果。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, apply, inject, name } from '../lib/plugin.mjs'
import { formatReport, probePort, handshake } from '../lib/doctor.mjs'
import { compareVersions, formatVersion, parseVersion } from '../lib/resolve.mjs'
import { classifyAddon, parseAddonInfo } from '../lib/addon.mjs'

/** 收集注册结果的假上下文。 */
function fakeCtx() {
  const registered = []
  return { registered, ctx: { tools: { register: (tool) => registered.push(tool) } } }
}

test('插件导出约定的三件套', () => {
  assert.equal(name, 'blender-mcp')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'Config 应是 schemastery 的 schema 构造器')
})

test('Config 提供可用默认值', () => {
  const resolved = Config({})
  assert.equal(resolved.host, 'localhost')
  assert.equal(resolved.port, 9876)
  assert.equal(resolved.probe, true)
  assert.equal(resolved.executable, '')
})

test('apply 注册唯一一个工具，且形状符合工具契约', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, Config({}))

  assert.equal(registered.length, 1, '只应注册一个工具')
  const tool = registered[0]
  assert.equal(tool.name, 'blender_mcp_doctor')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.presentCall, 'function')
  assert.ok(tool.description.length > 50, '描述应说明何时使用')
  assert.ok(tool.description.includes('只读'), '描述应声明只读，避免模型误以为它会改配置')
})

test('参数均为可选，输出 schema 闭合且必填项正确', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, Config({}))
  const tool = registered[0]

  // defineTool 会把 DSL 规范化成 {type:'object', properties:{...}}。
  // 两个参数都可选——无参数调用必须合法，因此参数级不应出现 required 数组。
  const params = tool.parameters
  assert.equal(params.type, 'object')
  assert.equal(params.required, undefined, '本工具无必填参数')
  assert.equal(params.properties.deep.type, 'boolean')
  assert.equal(params.properties.probe.type, 'boolean')

  const schema = tool.output.schema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false, '输出应为闭合对象')
  for (const field of ['ok', 'state', 'summary', 'nextAction', 'checks', 'blender']) {
    assert.ok(schema.properties[field], `缺少字段：${field}`)
    assert.ok(schema.required.includes(field), `${field} 应在 required 数组里`)
  }
  assert.ok(!schema.required.includes('addon'), 'addon 可为 null，不应是必填')
  assert.ok(!schema.required.includes('socket'), 'socket 可为 null，不应是必填')

  // 可空字段必须显式声明 null 分支，否则模型会在 null 上取属性。
  for (const nullable of ['addon', 'socket']) {
    assert.ok(Array.isArray(schema.properties[nullable].oneOf), `${nullable} 应使用 oneOf 表达可空`)
    assert.ok(
      schema.properties[nullable].oneOf.some((branch) => branch.type === 'null'),
      `${nullable} 的 oneOf 应包含 null 分支`,
    )
  }
})

test('execute 在真实环境返回可渲染的成功结果', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, Config({}))
  const tool = registered[0]

  // probe:false 让本测试不启动 Blender，保持在毫秒级且无副作用。
  const value = await tool.execute({ probe: false, deep: false })

  assert.equal(typeof value.ok, 'boolean')
  assert.ok(typeof value.state === 'string' && value.state.length > 0)
  assert.ok(Array.isArray(value.checks) && value.checks.length > 0)
  assert.ok(value.blender, 'blender 字段始终存在')
  assert.ok(['probe', 'user-appdata', 'user-localappdata', 'portable', 'none'].includes(value.blender.source))

  const rendered = tool.output.render({}, value, {})
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('体检'), '渲染文本应带标题')
  assert.ok(rendered[0].text.includes('下一步：'), '渲染文本应包含下一步动作')
})

test('版本解析与比较', () => {
  assert.deepEqual(parseVersion('4.5.14 LTS'), [4, 5, 14])
  assert.deepEqual(parseVersion('4.5'), [4, 5])
  assert.equal(parseVersion('不是版本'), null)
  assert.equal(compareVersions([4, 5], [4, 5, 0]), 0, '4.5 与 4.5.0 应等价')
  assert.equal(compareVersions([4, 5, 1], [4, 5, 0]), 1)
  assert.equal(compareVersions([4, 5, 0], [4, 5, 1]), -1)
  assert.equal(formatVersion([4, 5, 14]), '4.5.14')
  assert.equal(formatVersion(null), 'unknown')
})

test('解析 bl_info 中的版本与名称', () => {
  const source = `bl_info = {\n    "name": "MCP for Blender",\n    "version": (1, 8),\n}`
  const info = parseAddonInfo(source)
  assert.deepEqual(info.version, [1, 8])
  assert.equal(info.name, 'MCP for Blender')
  assert.deepEqual(parseAddonInfo('无 bl_info').version, null)
})

test('插件版本关系分类', () => {
  const bundled = { version: [1, 8] }
  assert.equal(classifyAddon(bundled, { installed: false }), 'missing')
  assert.equal(classifyAddon(bundled, { installed: true, matchesBundled: true }), 'match')
  assert.equal(classifyAddon(bundled, { installed: true, matchesBundled: false, version: [1, 7] }), 'outdated')
  assert.equal(classifyAddon(bundled, { installed: true, matchesBundled: false, version: [1, 9] }), 'newer')
  assert.equal(classifyAddon(bundled, { installed: true, matchesBundled: false, version: [1, 8] }), 'diverged')
})

test('端口探测：未监听时快速返回 false，不抛错', async () => {
  // 占用一个端口再释放，得到一个几乎必然空闲的高位端口。
  const closed = await probePort({ port: 59999, timeoutMs: 500 })
  assert.equal(typeof closed, 'boolean')
  assert.equal(closed, false, '空闲端口应判定为未监听')
})

test('握手：无监听时返回结构化失败而不是抛错', async () => {
  const result = await handshake({ port: 59998, timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.equal(result.identity, 'unknown')
  // Windows 上 Node 会把连接拒绝包成 AggregateError（message 为空），
  // 因此这里断言的是「有可读原因」，防止回归成空白提示。
  assert.ok(result.error && result.error.length > 0, `应带上可读的失败原因，实际为 ${JSON.stringify(result.error)}`)
})

test('formatReport 输出逐项结论与下一步', () => {
  const text = formatReport({
    ok: false,
    state: 'blender-closed',
    summary: '端口无人监听',
    nextAction: '请打开 Blender。',
    checks: [
      { name: 'blender', status: 'pass', detail: '找到了' },
      { name: 'socket', status: 'fail', detail: '端口空闲' },
    ],
    notes: ['一条说明'],
  })
  assert.ok(text.includes('需要处理'))
  assert.ok(text.includes('[OK  ] blender: 找到了'))
  assert.ok(text.includes('[FAIL] socket: 端口空闲'))
  assert.ok(text.includes('说明：一条说明'))
})
