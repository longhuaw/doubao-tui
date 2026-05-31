# ArkTerm

**[English](README.md) | [中文](README.zh-CN.md)**

🚀 多模型终端 AI 助手 — 火山方舟（豆包）· DeepSeek

ArkTerm 是一个纯 Node.js 构建的终端 AI Agent，通过 OpenAI 兼容 SDK 连接多个大模型，提供交互式 REPL 界面。支持 8 个内置工具，包括文件操作、Shell 命令执行、Git 助手，以及**微信实时消息监听与自动回复**。

## 核心特性

- **纯原生 Node.js**：无需 Python，npm 一键安装。所有依赖均为纯 JS。
- **跨平台**：智能识别 Windows / macOS / Linux，自动适配 `dir`/`type` 与 `ls`/`cat`，GBK 编码正确处理。
- **AI Agent 模式**：模型自主决定工具调用，最大 5 轮推理往复，自动完成复杂任务。
- **8 个内置工具**：
  - `view_structure` — 查看目录结构
  - `read_file` — 读取文件（含 `.docx` 解析、大文件智能截断）
  - `write_file` — 创建/覆写文件
  - `patch_file` — 精确搜索替换（含尾随空白容错）
  - `execute_command` — 执行 Shell 命令（安全黑名单 + 用户确认）
  - `git_assistant` — Git 状态/差异/一键提交（自动生成 AngularJS 风格提交信息）
  - `switch_and_receive_wechat` — 切换到微信联系人并获取最新消息
  - `send_wechat_message` — 向微信联系人发送文本消息
- **流式显示**：`boxen` 实时面板，展示最后 200 字符输出 + TTFT / 生成速度 / 平均速度。
- **Markdown 渲染**：AI 回复经 `marked` + `highlight.js` 转为终端彩色输出，支持代码高亮和 diff 展示。
- **微信深度集成**：
  - 持久 PowerShell 子进程轮询微信 UIA 树，实时检测新消息
  - AI 自动生成回复（学习用户聊天风格 + 对话上下文）
  - 数字键一键发送，Enter 清空队列
  - 纯后台模式（`ARKTERM_WECHAT_BACKGROUND_ONLY=1`），接收消息时不弹窗不抢焦点
  - 物理鼠标点击模拟，可靠完成联系人切换
- **会话压缩**：消息超过 15 条时自动滑动窗口压缩，保留操作摘要 + 最后 6 条推理窗口。
- **安全机制**：命令黑名单（高风险立即拒绝，中风险阻断），路径操作限定在工作区/Home/Desktop/Documents/Downloads。
- **配置持久化**：首次运行交互式向导，配置保存至 `~/.arkterm.env`，CWD 的 `.env` 可覆盖。

## 快速开始

确保已安装 [Node.js (v18+)](https://nodejs.org/)。

```bash
# 全局安装
npm install -g arkterm

# 启动
arkterm

# 或本地开发
git clone https://github.com/longhuaw/ArkTerm.git
cd ArkTerm
npm install
npm start
```

首次运行会启动交互式配置向导，填写各模型的 API Key 和模型名称。

## 配置

### 环境变量

配置保存在 `~/.arkterm.env`，也可在项目目录创建 `.env` 覆盖。

```bash
# 火山方舟（豆包）
VOLC_API_KEY=your_api_key
DOUBAO_ENDPOINT_ID=your_endpoint_id

# DeepSeek
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_MODEL=deepseek-chat

# 微信功能（可选）
ARKTERM_WECHAT_BACKGROUND_ONLY=1  # 纯后台模式：接收消息时不弹出微信
```

所有模型通过 OpenAI 兼容 SDK 统一调用。

### 模型别名

| 别名 | 模型 |
|------|------|
| `doubao` / `db` | 豆包（火山方舟） |
| `deepseek` / `ds` | DeepSeek |

## 使用说明

### REPL 命令

| 命令 | 说明 |
|------|------|
| `/auto` | 切换自动批准模式（跳过命令安全确认） |
| `/model <name>` | 切换模型（`db` / `ds` 或完整名称） |
| `/clear` | 清除对话历史 |
| `/save` | 保存对话至 `~/.arkterm_history.json` |
| `/help` | 显示帮助和模型列表 |
| `/exit` | 退出 ArkTerm |
| `Tab` | 循环切换可用模型 |
| `Ctrl+C` × 2 | 第一次警告，5 秒内第二次退出 |

### 微信功能

微信集成通过 Windows UIAutomation（UIA）实现对微信 PC 版的监听和操作。需要 Windows 系统，微信 PC 版需正在运行。

**消息提醒**：当收到新微信消息时，终端会打断当前输入行显示消息提醒，同时 AI 自动生成简短回复建议。

```
🔔 [WeChat 实时提醒] 小华: 晚饭吃什么？

💡 [ArkTerm 待发队列]:
  [1] (小华): "食堂吧，懒得出去"
  按对应数字键一键发送  |  按 [Enter] 或其他键清空队列
```

**发送消息**：按数字键（1-9）发送对应的 AI 建议回复；支持排队多条回复依次发送。

**联系人切换**：AI 可通过 `switch_and_receive_wechat` 工具自动切换到指定联系人窗口，获取对话历史用于上下文感知回复。

**纯后台模式**：设置 `ARKTERM_WECHAT_BACKGROUND_ONLY=1` 后，接收消息不会弹出微信窗口、不抢焦点。仅在用户主动发送消息时短暂激活微信完成操作后恢复。

### AI Agent 工具

Agent 模式下，所有 8 个工具始终可用，模型自主决定是否调用。工具调用通过 OpenAI function calling 协议，不支持原生 function calling 的模型有文本解析回退。

## 架构

```
bin/index.js          # CLI 入口
src/
  main.js             # REPL 循环、流式显示(boxen)、Agent 循环、raw-mode 输入
  config.js           # 环境变量加载、模型注册表、交互式配置向导(inquirer)
  session.js          # ChatSession — 内存消息历史 + 滑动窗口压缩
  security.js         # 命令黑名单 + 用户确认提示
  tools.js            # 8 个工具实现 + 路径解析/安全检查 + function-calling schema
  ui.js               # Markdown 渲染(marked+highlight.js) + diff 展示 + spinner(ora)
  wechat.js           # 微信 UIA 监听 — 持久 PowerShell 子进程 + AI 回复生成 + 消息收发
wechat_radar.ps1      # PowerShell 持久雷达脚本 — 轮询微信 UIA 树，输出 JSON 行
```

## 开发

```bash
npm install          # 安装依赖
npm start            # 启动开发模式
npm test             # 所有源文件语法检查
npm version patch    # 升级版本号（git tag 触发 CI 自动发布到 npm）
git push --tags
```

## CI/CD

`.github/workflows/publish.yml` — 推送 `v*` 标签时自动发布到 npm，需要 `NPM_TOKEN` secret。

## 贡献

欢迎提交 Issue 或 Pull Request。

## 许可证

MIT
