# MCP patch 与导入

每个文件保留下面的四行注释，供委派 skill 低成本发现。模板中的 stdio 和 HTTP 二选一，按所装 dsh 版本的 `@deepseek-ai/dsh-mcp-client/README.md` 核对可选字段。

```yaml
# dsh-mcp: <name>
# 用途: <该 MCP 提供的能力>
# 前提: <应用、服务、项目或实例要求；没有则写 无>
# 用法: dsb run --cwd <项目> --brief <文件> --patch ~/.dsh/patches/<name>-mcp.yml
- insert:
    - id: mcp-<name>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>
        transport: stdio
        command: npx
        args: ['-y', '<package>@<version>']
        env:
          API_TOKEN: !!js process.env.API_TOKEN ?? ''
        # cwd: <工作目录>
        # HTTP 配置时删除 command / args，改用：
        # transport: streamable-http
        # url: http://127.0.0.1:3000/mcp
        # headers: { Authorization: !!js '`Bearer ${process.env.MCP_TOKEN ?? ""}`' }
        toolCallTimeoutMs: 120000
        failOnStartupError: true
```

`serverName` 使用 `[A-Za-z0-9_-]{1,32}`，在已装 patch 中唯一，工具名前缀为 `mcp__<serverName>__`。按实际工具耗时设置 `toolCallTimeoutMs`，不要用很长的超时掩盖连接错误。启动失败应明确报错，避免悄悄缺工具后跑偏。

## 凭据

当前 dsh MCP 客户端不会自动继承名字带 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的变量或 `DSH_*` 变量；需要在 `env` 显式转发。变量引用写 `!!js process.env.NAME ?? ''`，并在运行前确认必需变量已设置。

从其他客户端遇到明文密钥时，改成环境变量引用，说明需设置的变量名。不要将密钥放到命令示例、报告、patch 头注释或版本控制中，也不要为验证配置而输出展开后的完整配置。

## 配置来源

下表是常见客户端示例，不是完整清单；其他客户端按其官方 MCP 文档找到 server 定义即可，语义相同：启动命令用 command/args/cwd，环境变量用 env，远程服务用 url 和请求头（传输类型按下文映射）。

| 来源 | 位置 |
|---|---|
| Claude Code | `claude mcp get <name>`；`~/.claude.json` 中全局及项目的 `mcpServers`；项目 `.mcp.json` |
| Codex | 当前生效配置的 `[mcp_servers.<name>]`；默认用户配置 `~/.codex/config.toml`，自定义 `CODEX_HOME` 时位于该目录；同时检查已信任项目从根目录到当前目录适用的 `.codex/config.toml`，以及已启用 profile 的覆盖 |
| Claude Desktop | Windows 用 `%APPDATA%\Claude\claude_desktop_config.json`，macOS 用 `~/Library/Application Support/Claude/claude_desktop_config.json`，Linux 以其官方文档为准；仍是 `mcpServers` 字段 |

字段映射（下列字段名主要来自 Codex 配置，其他客户端按语义对应）：

- `command` / `args` / `cwd`：保留已确认的启动语义，确认本机路径存在。
- `env` / `headers`：保留变量名与认证方式，凭据改成上面的环境引用。
- `type: http` 或 `url`：映射为 `transport: streamable-http`，保留 URL 和必要 headers；其他传输类型先核对兼容性，不强行当作 HTTP。
- `env_vars = ["X"]`：映射为 `env: { X: !!js process.env.X ?? '' }`。若使用带 `source: remote` 的对象形式，不能改从本机环境取值；先确认原执行环境与依赖是否可在 dsh 中等价配置。
- Codex 的 `http_headers` / `env_http_headers`：映射为 `headers`；前者的凭据改为环境引用，后者按字段指定的变量名取值。`bearer_token_env_var = "X"` 映射为 `Authorization: !!js '"Bearer " + (process.env.X ?? "")'`，避免与已有 Authorization 重复。
- `tool_timeout_sec`：乘以 1000 转成 `toolCallTimeoutMs`；`startup_timeout_sec` 没有直接对应字段。

保留源配置的启用状态和工具限制。当前 dsh MCP 客户端不会映射 Codex 的 `enabled_tools` / `disabled_tools`、宿主审批规则、`http_headers_helper` 或 OAuth/ChatGPT 登录状态；不能靠复制 URL 或 prompt 等价继承这些能力。需要原有工具限制、资源/提示能力或无法转接的认证时，保留该操作由主代理执行，或先配置具备等价约束的 server；不要静默丢弃限制后导入。

Codex 字段与配置层级以官方 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和 [配置说明](https://learn.chatgpt.com/docs/config-file/config-advanced) 为准。

依赖安装、变更目标应用或外部服务应遵守本次用户授权。普通配置复用不需要重复导入或验证。
