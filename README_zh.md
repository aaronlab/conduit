# Conduit

**用你的 GitHub Copilot 账户，为 Codex CLI、Claude Code 和 OpenAI 客户端提供模型接口。**

简体中文 · [English](./README.md)

```text
Codex CLI -------- Responses API -------+
Claude Code ------ Messages API --------+--> Conduit :7133 --> GitHub Copilot
OpenAI 客户端 ----- Chat Completions ----+
                                            Dashboard :7023
```

Conduit 是本地、非官方的 Copilot 代理。Codex 走原生 Responses 协议，不把
自定义 `apply_patch`、图像、工具输出或加密推理状态降级成普通聊天消息；
现有 Claude Messages 透传及其兼容处理继续保留。

**本次对照并实测的是 Codex CLI 0.155.1，验证日期为 2026-09-20。**
这不代表 Copilot 提供了 OpenAI 的所有服务。模型可用性、工具、额度和计费，
仍由 GitHub 及你的组织策略决定。

## 快速开始

需要 Bun 1.3+、有 Copilot 权限的 GitHub 账户，以及 macOS/Linux/WSL。
使用 Codex 时，还需要安装 [官方 CLI](https://github.com/openai/codex)。

```bash
git clone https://github.com/aaronlab/conduit.git
cd conduit
bun install

# 保留已有密钥，不要提交到 Git。
test -s .conduit-key || (umask 077; openssl rand -hex 32 > .conduit-key)
export CONDUIT_API_KEY="$(cat .conduit-key)"
# 仅用于本地 Dashboard；VITE_* 会进入浏览器端代码。
export VITE_API_KEY="$CONDUIT_API_KEY"
bun run dev
```

首次启动按提示完成 GitHub 设备登录。代理监听 `:7133`，Dashboard 监听
`:7023`。不要把未配置鉴权的开发实例暴露到网络。

上述命令生成的是纯 key 文件。Codex 启动器也兼容旧版
`CONDUIT_API_KEY=...` 格式；这种文件启动代理时应导出赋值中的 key，
不要把整行作为 key。Dashboard 请仅供本地使用，不要公开部署带真实
`VITE_API_KEY` 的前端构建产物。

### 使用 Codex

在仓库目录另开一个终端：

```bash
./bin/conduit-codex
./bin/conduit-codex --help
```

启动器读取 `CONDUIT_API_KEY` 或本地 `.conduit-key`，获取当前账户的
Codex 模型目录，再通过自定义 Responses provider 启动 Codex。
**不会覆盖你的 Codex 配置、登录状态，也不会关闭沙箱或审批。**

模型选择、手动配置、联网搜索、浏览器 MCP 和故障排查见
[Codex 专项说明](./docs/CODEX.md)。

### 使用 Claude Code

请从当前账户实际可用的模型中选择：

```bash
unset ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=http://127.0.0.1:7133
export ANTHROPIC_AUTH_TOKEN="$(cat .conduit-key)"
export ANTHROPIC_MODEL=<当前可用的模型 ID>
claude
```

可用的 Claude 模型继续走原生 Messages 接口；其他模型保留原有翻译链路。
Claude 别名不可用时的既有回退逻辑，以及
`Anthropic web_search_* -> Sol /responses web_search` 适配也保留。
旧模型名称与兼容处理见 [模型兼容说明](./docs/MODEL_COMPATIBILITY.md)。

## 哪些能力已经验证

| 能力 | 结果 |
|---|---|
| Codex HTTP/SSE、shell、自定义 `apply_patch` | 真实 CLI 端到端通过 |
| 多轮函数、自定义工具、MCP 工具结果 | 保留原协议，支持图像结果 |
| 加密推理、指令、结构化输出及新增 Responses 字段 | 原生透传 |
| 原生 `web_search` | Sol 实测通过，仍取决于上游和模型 |
| CLI 浏览器操作 | 隔离的 Playwright MCP 实测通过 |
| 原生 `computer` / `computer_use_preview` | **Copilot 实测返回不支持** |
| WebSocket Responses | 未启用；明确回退到 HTTP |
| OpenAI `/responses/compact` | 不伪造兼容；使用 Codex 本地上下文压缩 |
| 仅支持 Chat 的模型直接用于 Codex | 不冒充 Responses 模型 |
| Claude Messages / OpenAI Chat | 保留，并加入相关回归测试 |

代理不再自动删除大型历史工具结果，也不再自动把请求内容、截图写到诊断文件。
超出上游限制会明确报错，而不是悄悄丢上下文。

## 验证与开发

```bash
bun run test
bun run typecheck

# 主动运行：会向已启动的代理发送真实请求，消耗 Copilot 用量。
bun run test:codex --model gpt-5.4-mini

# 浏览器测试额外需要 Chrome 和指定版本的 Playwright MCP。
bunx @playwright/mcp@0.0.82 --help
bun run test:codex --model gpt-5.4-mini --browser
```

测试使用临时 Codex home 和临时工作目录，核对真实 shell 输出、
`apply_patch` 创建的文件和严格 JSON 结果；可选浏览器测试还会验证
真实表单操作及截图回传，不把模型口头说“成功”当成通过。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONDUIT_PORT` | `7133` | 代理端口 |
| `CONDUIT_API_KEY` | 空 | 客户端鉴权；留空为无鉴权开发模式 |
| `CONDUIT_INTERNAL_KEY` | 空 | Dashboard 到代理的鉴权 |
| `CONDUIT_TOKEN_PATH` | `packages/proxy/data/github_token` | GitHub token 文件 |
| `CONDUIT_DB_PATH` | `data/conduit.db` | 相对代理进程工作目录的数据库路径 |
| `CONDUIT_BASE_URL` | 空 | 对外展示的代理地址 |

GitHub token 与客户端访问 Conduit 的 key 是两种不同凭据。
不要提交凭据、生成的模型目录或数据库。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/responses` | 原生 Copilot Responses，支持 SSE |
| GET | `/v1/models?client_version=0.155.1` | Codex `ModelInfo` 模型目录 |
| GET | `/v1/models` | OpenAI 格式的模型列表 |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/chat/completions` | Chat Completions；按最新模型元数据选择 Responses 桥接 |
| GET | `/health` | 健康检查 |
| GET | `/api/copilot/models?refresh=true` | 刷新 Copilot 模型能力 |
| GET | `/api/stats`、`/api/requests` | 请求元数据、用量和错误监控 |

更多说明：[架构](./docs/ARCHITECTURE.md) · [FAQ](./docs/FAQ.md) ·
[远程操作 Claude Code](./docs/REMOTE_ACCESS.md)。

## 许可证

MIT。Conduit 与 GitHub、OpenAI、Anthropic 没有官方关联。
请只使用你获准使用的账户，并遵守相关服务条款和组织策略。
