---
name: dsh-mcp
description: Install, import, inspect, update, or remove MCP server patches for DeepSeek Harness (dsh) from any host agent with local command execution, or diagnose missing connections and invalid configuration. Reuse working patches for delegation.
---

# 管理 dsh 的 MCP

供具备本地命令执行能力的任意宿主代理使用，Claude Code 和 Codex 是示例。要求 Node.js >=24.9、`@deepseek-ai/dsh` >=0.2.1-rc.2 和当前 dpsk-bridge。一个 MCP server 对应 `~/.dsh/patches/<name>-mcp.yml`，通过 SDK 双向会话的 `dsb run --patch <文件>` 按需加载，可重复此参数。宿主可用的 MCP 不会自动出现在 dsh 中；只加载本任务需要的 server，避免额外工具定义和启动开销。

## 列出与复用

读取 patch 的前 4 行即可了解名称、用途、前提和用法：

在 Bash 中可用 `head -n 4 ~/.dsh/patches/*-mcp.yml`；PowerShell 中用 `Get-ChildItem -Path ~/.dsh/patches -Filter '*-mcp.yml' | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 4 }`。按实际 shell 选择命令。

没有匹配文件只表示尚未配置。列出配置时不读取或打印整个凭据环境。配置没有变化、验证结果可用且运行前提满足时，直接复用，不为每次委派重新安装或测试。

## 安装或导入

1. 从用户现有配置或 server 官方说明确定启动方式和依赖。只导入指定 server，不复制整个客户端配置。
2. 按 [patch 模板与字段映射](references/configuration.md) 写配置；只有安装、更新或排错需要读取该参考。
3. 检查命令、依赖、目标应用/实例及必需环境变量是否就绪。检查变量只报告名称和是否设置，不显示值。保留与本次目标匹配的项目参数；目标不明确时先澄清，不擅自删除项目绑定。
4. 进行下面的验证，报告 patch 路径、使用方法、前提及需要用户设置的变量。

有凭据的字段使用环境变量引用，不写入明文。`?? ''` 只避免 undefined 导致配置解析失败，不代表空凭据能通过认证；必需凭据未设置时先报告缺失，不反复启动模型尝试。

## 用最少调用验证

先用 `dsh --profile sdk --patch <文件> --dump-config` 在本地验证配置可以组合，只报告是否成功和相关的脱敏错误，不将整份配置输出到对话。

再验证连接与工具注册。如果已有无需模型调用的 MCP 客户端或探测工具，优先复用它。否则通过一次有超时上限的 `dsb run --patch <文件>`，让 dsh 确认指定前缀工具存在，并调用一个与目标匹配、无需额外外部动作的只读工具；返回工具名和简短结果证据。默认路由为 `deepseek-official` / `deepseek-v4-flash`，可用 `--provider` / `--model` 或 `DPSK_PROVIDER` / `DPSK_MODEL` 覆盖。前提未满足时不调用，不能拿模型列出的名称代替真实调用结果。

验证中保留宿主进程会话，用短而有界的等待读取 `dsb events <ID>` 和 `dsb status <ID>` 的 `pendingRequests`。使用 `dsb answer` 回复问题或权限请求，只有现有用户授权覆盖操作时才能批准；不能自行决定时向用户澄清。入队不等于送达，核对后续 `input_delivered` / `input_rejected`。共享同一应用或 MCP 实例的并发作业应使用相同 `--resource <名称>`；只读声明和资源预约不能替代应用权限或沙箱。

一次验证同时覆盖发现与只读调用，不分成两次付费模型调用。工具错误、无工具、权限不足分别报告；未经实际调用验证时明确说明，不能标记为已验证。将验证时间、server/patch 版本及简短结果记在 patch 的额外注释中（不改变前四行）；后续配置或依赖发生变化时再验证。

## 更新与卸载

更新前检查现有 patch；只改所需字段，保留用户设置。尽量保持 `serverName`，它决定工具名称前缀。更新后重新验证。

用户明确要求卸载指定 MCP 时，检查该 patch、备份后删除，并用 `rg` 检查当前相关项目的引用，提醒需要调整的 brief。对象不明确时再询问，不重复请求已经给出的卸载授权。不顺带卸载 npm/uv 包、删除凭据或终止共享服务。

## 常见问题

- `invalid config`：检查字段类型、未设置环境变量，以及 patch 是否只加载了本任务需要的 server。
- 启动失败：检查启动命令、依赖、应用是否打开、端口或 URL。
- 连接成功但没有工具：读取 server 的相关错误日志，不让模型反复猜工具名。
- 单次工具超时：先只读检查操作结果，尤其是有状态的编辑器；不要盲目重复可能已完成的操作。

如需固定组合可以建立自定义 profile；一般优先复用按需 patch。只在实际任务需要时加载 MCP，缓存折扣和总成本以实际用量为准。
