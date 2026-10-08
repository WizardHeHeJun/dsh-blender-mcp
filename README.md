# dsh-blender-mcp

让 DeepSeek Harness 一条命令接上 Blender。[MCP for Blender](https://github.com/ahujasid/mcp-for-blender)（原 `blender-mcp`）的官方安装脚本覆盖 Claude Desktop、Claude Code、Codex、Cursor、VS Code 等客户端，但**不认 DSH**——你得手工往 profile 的 `cordis.patch.yml` 里写 MCP 条目，再自己想办法把 Blender 侧插件装对位置。本插件把这三件事收成一件。

## 安装

```bash
dsh plugin --profile desktop add dsh-blender-mcp
dsh-blender-mcp install-addon
```

然后**重启 DSH**，并**打开 Blender**。就这两步。

模型会获得 10 个工具：9 个来自 MCP 服务端（`mcp__blender__execute_blender_code`、`mcp__blender__look`、`mcp__blender__get_scene_info` 等），外加本插件提供的只读体检工具 `blender_mcp_doctor`。

## 它替你做了什么

| 原先要手工做的事 | 现在 |
| --- | --- |
| 往 `cordis.patch.yml` 写 `mcp-client` 条目 | 本包的 bundle patch 声明式注册，`dsh plugin add` 时自动加入 profile 的 `bundles` |
| 猜 Blender 的插件目录（绿色版/装机版/端口式布局各不相同） | 启动一次 Blender 让它**自己报告**真实目录（约 1 秒），再写入插件 |
| 连不上时毫无提示（表现只是工具列表为空） | `blender_mcp_doctor` 逐项摊开结论，并给出唯一一条下一步动作 |

## 体检工具

模型在 `mcp__blender__*` 工具缺失或调用失败时会先调用它。它**完全只读**：不装插件、不改偏好设置、不写任何文件。返回逐项结论：

```
Blender MCP 体检：需要处理 — 插件已安装（1.8），但 localhost:9876 无人监听——通常是 Blender 没打开
  [OK  ] blender: Blender 4.5.14 LTS，插件目录经 probe 解析：C:\...\Blender\4.5\scripts\addons
  [OK  ] addon: 已安装 1.8（与本包自带一致）
  [FAIL] socket: localhost:9876 无监听
  下一步：插件已就位，但端口无人监听——请打开 Blender。……
```

`state` 字段的取值与含义：

| state | 含义 | 下一步 |
| --- | --- | --- |
| `ok` | 连接正常 | 直接用 |
| `no-blender` | 未找到 Blender | 安装 Blender，或用 `--blender` 指定路径 |
| `no-addon` | Blender 插件未安装 | `dsh-blender-mcp install-addon` |
| `addon-outdated` | 已装插件版本落后于本包自带版本 | `dsh-blender-mcp install-addon` |
| `blender-closed` | 插件就位但端口无人监听 | 打开 Blender |
| `addon-too-old` | 端口上的插件过旧，不认识 `ping` | `dsh-blender-mcp install-addon` |
| `port-conflict` | 端口被非 Blender 程序占用 | 换端口并同步本包配置 |

## 命令行

装插件是运维动作，因此**只有命令行能做**，模型拿不到写入能力。

```bash
dsh-blender-mcp doctor           # 体检，退出码 0=可用，1=需处理
dsh-blender-mcp install-addon    # 安装/更新 Blender 侧插件（幂等，覆盖前备份为 .bak）
dsh-blender-mcp paths            # 列出探测到的插件目录及已装状态
```

选项：`--blender <路径>`、`--no-probe`（不启动 Blender，仅静态探测）、`--port`、`--host`、`--force`、`--json`。

## 配置

```yaml
- id: blender-mcp
  name: dsh-blender-mcp
  config:
    host: localhost      # Blender 插件监听主机
    port: 9876           # Blender 插件监听端口
    executable: ''       # Blender 可执行文件；留空自动查找
    probe: true          # 是否允许启动一次 Blender 获取真实插件目录
```

**端口要改就得改两处**：本插件配置里的 `port`，以及 `cordis.patch.yml` 中 `mcp-blender-server` 条目的服务端连接端口，还有 Blender 插件面板里的监听端口。三处一致才生效。

## 已知约束

- **必须先打开 Blender。** 服务端经 `localhost:9876` 连 Blender 内的 socket，Blender 不开就连不上。这由 `blender_mcp_doctor` 明确报出，不再是静默失败。
- **Blender 后台模式不支持。** 上游插件在 `blender -b` 下会拒绝启动服务端（「commands would never execute」），因此无头渲染自动化用不了本插件。
- **自带插件版本会与上游产生时差。** 本包内嵌的 `blender_mcp.py` 是快照；上游发布新版后需由维护者执行 `npm run sync-addon`（见 `scripts/sync-addon.mjs`）同步。体检会报出版本不一致。
- **`serverName` 冲突。** 若你此前已手工加过等价的 `mcp-client` 条目（同样 `serverName: blender`），请先删除手工条目，否则加载时会因重名失败。
- **需要 `uvx`。** MCP 服务端由 `uvx` 拉起。若客户端解析不到 `uvx`，把 `cordis.patch.yml` 里的 `command` 改成绝对路径（Windows 通常是 `C:\Users\<你>\.local\bin\uvx.exe`）。
- **安全。** 上游插件的 socket 无认证无加密，且 `execute_blender_code` 等于在 Blender 里跑任意 Python。默认只监听 localhost，**不要把它暴露到局域网**。

## 测试

```bash
npm install
npm test
```

11 项测试覆盖插件注册契约、输出 schema 形态（含可空字段的 `null` 分支）、版本比较、插件版本关系分类、端口探测与握手的失败路径。这些用例不需要 Blender 在运行。

## 归属与许可

本包内嵌 `mcp-for-blender` 的 Blender 侧插件（`lib/addon/blender_mcp.py`），版权归其作者 Siddharth（[ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender)），MIT 许可。详见 [PROVENANCE.md](./PROVENANCE.md)。

本包自身以 MIT 许可发布，与 Blender Foundation 及 mcp-for-blender 作者均无隶属关系。
