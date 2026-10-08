# 第三方归属与来源记录

本包包含一份**内嵌的上游产物**，此文件记录其来源、版本与同步方式，便于下游
审计与后续维护。

## 内嵌内容

| 项 | 值 |
| --- | --- |
| 文件 | `lib/addon/blender_mcp.py` |
| 来源仓库 | [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) |
| 上游包 | PyPI `mcp-for-blender`（原 `blender-mcp`） |
| 包内路径 | `blender_mcp/bundled/addon.py` |
| 作者 | Siddharth Ahuja |
| 许可 | MIT（Copyright (c) 2025 Siddharth Ahuja） |
| 抓取时上游包版本 | `2.1.9` |
| 内嵌插件版本（`bl_info["version"]`） | `1.8` |
| 内嵌文件大小 | 270889 字节 |
| 内嵌文件 sha256 | `eb0facf69781a30e69792532087d8d41c6a14fcd323353250abe7988ee297fa5` |

补充说明：上游的「包版本」（2.1.9，指 PyPI 上的 Python 服务端）与「插件版本」
（1.8，指 `bl_info["version"]`，即 Blender 侧识别到的版本）是两套独立编号。
本包体检报告中的插件版本指的是后者。

之所以内嵌而不是在安装时下载：安装 Blender 侧插件必须是离线可用且可复现的，
而 `uvx mcp-for-blender install-addon` 依赖网络与上游对 Blender 安装形态的判断
（本机实测：绿色版 Blender 会让该命令给出与实际不符的路径）。

## MCP 服务端

本包**不内嵌**服务端。`cordis.patch.yml` 通过 `uvx --from mcp-for-blender
mcp-for-blender` 在运行时拉取，与上游保持同源，因此服务端始终是最新版。

## 同步方式

```bash
node scripts/sync-addon.mjs           # 拉取上游最新并写入
node scripts/sync-addon.mjs --check   # 只对比，有差异时退出码 1（CI 用）
node scripts/sync-addon.mjs --version=2.1.9   # 指定上游包版本
```

脚本用 `uv pip install --target` 把上游包拉到临时目录，定位
`blender_mcp/bundled/addon.py`，与内嵌副本做 sha256 比对后按需覆盖。同步后
请更新本文件上表的三个字段（上游包版本、插件版本、sha256、文件大小），并
按需提升本包版本号。

## 无隶属关系

本包与 Blender Foundation、以及 MCP for Blender 的作者均无隶属关系，为非官方
第三方集成。
