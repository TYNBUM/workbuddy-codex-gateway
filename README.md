# WorkBuddy → Codex 本地网关

在 WorkBuddy 中开发、执行 skill，通过本机网关调用已经登录 ChatGPT 的 Codex 账号。模型返回的工具调用交回 WorkBuddy 执行，文件操作、skill、连接器仍使用 WorkBuddy 的运行环境。

```text
WorkBuddy 自定义模型
        │ OpenAI Chat Completions（含流式响应、工具调用）
        ▼
127.0.0.1:18789 本地网关
        │ Codex ChatGPT 登录身份
        ▼
Codex 模型服务
```

网关通过 Codex backend 发送模型请求。该后端接口不是面向第三方网关的公开稳定 API，更新后可能需要调整。请求使用当前 Codex 账号的正常额度，并受该账号的模型权限、用量限制和限流约束；不会增加额度，也不会把 ChatGPT/Codex 额度变成 OpenAI API 余额。必须使用 ChatGPT 账号登录 Codex，API Key 登录不满足本项目的目标。

## 快速开始

需要 Windows、Node.js **24.5 或更新版本**、已安装并完成 ChatGPT 登录的 Codex，以及 WorkBuddy 桌面端。项目不需要 `npm install`，仅使用 Node 内置模块。

1. 将 `gateway.config.example.json` 复制为 `gateway.config.json`，把 `models[].upstream` 中的 `REPLACE_WITH_YOUR_CODEX_MODEL` 替换为自己 Codex 账号可用的模型名。默认不指定代理，需要时设置自己的 `networkProxy`。
2. 双击 `doctor.cmd` 检查 Node、Codex 登录与当前配置。首次尚未启动或写入 WorkBuddy 配置时出现对应“检查”提示正常。
3. 双击 `configure.cmd`，向 `%USERPROFILE%\.workbuddy\models.json` 追加 Codex 模型，已有条目会保留。脚本自动备份原文件。
4. 双击 `start.cmd`，网关在后台隐藏运行。默认地址为 `http://127.0.0.1:18789/v1`。
5. 回到 WorkBuddy，在当前会话的模型选择器中**明确选择 Codex 自定义模型**。Auto 不保证使用新模型。若列表未刷新，完全退出 WorkBuddy 后重新打开。
6. 先发送短文本，再让它在测试目录创建并读取一个文件，核验工具调用确实由 WorkBuddy 执行。

如果没有手动复制配置，首次执行 `configure`、`start` 或 `doctor` 会从模板创建默认配置文件，并提示填写模型名。`gateway.config.json` 属于个人配置，已加入 `.gitignore`；仓库只包含不带账号凭据和个人代理设置的模板。

关闭 WorkBuddy 不会自动关闭网关；不用时双击 `stop.cmd`。启动时会识别现有服务，停止时只向身份匹配的本网关发送带鉴权的关闭请求，不根据旧 PID 强杀进程。

## 命令

在项目目录中运行：

```powershell
node .\cli.mjs start
node .\cli.mjs status
node .\cli.mjs doctor
node .\cli.mjs stop
node .\cli.mjs configure
node .\cli.mjs remove-config
node .\cli.mjs restore-config
```

`doctor` 仅检查本地登录模式、模型配置和健康状态，不发送模型推理请求。它不会显示 Codex token 或网关密钥。健康检查通过不代表账号额度或每个模型已通过真实调用验证。

WorkBuddy 国际版或自定义配置目录可以显式指定目标：

```powershell
node .\cli.mjs configure --workbuddy-config "$env:USERPROFILE\.workbuddy-ai\models.json"
node .\cli.mjs doctor --workbuddy-config "$env:USERPROFILE\.workbuddy-ai\models.json"
```

脚本保留配置的原有容器结构，支持顶层数组及已有的 `models` 数组对象。相同模型 ID 如果指向别的地址，脚本会停止并保留原配置。

## 配置和运行文件

网关监听本机 `127.0.0.1`，使用随机生成的本地 Bearer 密钥。该密钥只供 WorkBuddy 连接本网关，不是 OpenAI API Key；`configure` 会自动写入 WorkBuddy 模型条目，不需要手动复制。

运行文件位于 `%LOCALAPPDATA%\WorkBuddyCodexGateway`：

- `local-key`：本机网关鉴权密钥。
- `gateway.stdout.log`、`gateway.stderr.log`：后台运行日志。
- `config-history-*.json`：本项目模型配置的变更记录，用于选择性恢复。

自定义模型配置和恢复记录可能包含本机网关密钥；请勿将这些运行文件加入代码仓库或公开分享。

编辑项目根目录的 `gateway.config.json` 调整模型、代理和超时。模板使用 `medium` 思考强度、`networkProxy: null`，并要求用户填写实际模型名。模型条目的含义如下：

```json
{
  "models": [
    {
      "id": "codex-model",
      "name": "Codex",
      "upstream": "REPLACE_WITH_YOUR_CODEX_MODEL"
    }
  ]
}
```

`id` 是 WorkBuddy 使用的唯一模型标识，`name` 是界面显示名称，`upstream` 是实际 Codex 模型名。必须替换占位符，并确保账号有权使用该模型。此片段只说明模型条目；完整配置请以 `gateway.config.example.json` 为准。

`start` 启用 Node 的环境代理支持；若配置提供 `networkProxy`，会设置子进程的 HTTP/HTTPS 代理，并让本机回环请求绕过代理。高级配置可设置 `codexAuthFile`、`codexCommand`；默认自动查找当前用户的 Codex 登录文件与命令。环境变量 `WB_CODEX_CONFIG` 可指定另一份网关配置，`WB_CODEX_STATE_DIR` 可指定运行文件目录。

修改网关配置后执行 `stop`、`start` 重新加载。若需要更换端口，先用旧配置执行 `stop` 和 `remove-config`，再修改端口、执行 `configure` 和 `start`，避免旧服务仍占用端口或同名模型指向旧地址。

## 移除与恢复

```powershell
node .\cli.mjs stop
node .\cli.mjs remove-config
```

`remove-config` 只移除本项目声明的模型 ID 与本机接口地址同时匹配的条目，保留其他模型。它不会删除 Codex 登录信息，也不会卸载 WorkBuddy。

`restore-config` 撤销最近一次尚未撤销的 `configure` 或 `remove-config`：仅当目标条目与本项目写入后的状态完全一致时恢复；如果你后来手动改过该条目，会跳过并提示。其他模型和配置字段保持当前状态。每次实际写入前，还会把原始文件备份为同目录的 `models.json.workbuddy-codex-时间戳-PID-随机后缀.bak`。不要直接用老备份覆盖存在后续修改的整份配置。

## 常见问题

- **只能聊天、不能操作文件**：确认 WorkBuddy 选中了 Codex 模型，并启用该模型的“工具调用”。连接测试不能替代实际工具回合验证。
- **401 或登录已过期**：使用 Codex 自带登录流程重新登录 ChatGPT 账号，再重试。不要把账号 token 手动粘贴进 WorkBuddy。
- **429、额度耗尽或某模型不可用**：以当前 Codex 账号的模型权限和限额为准，等待恢复或选择账号可用模型。
- **端口被占用**：先执行 `status`。脚本不会终止占用该端口的其他应用。
- **连接上游失败**：检查系统代理、网关代理配置和 Codex 本身是否能正常使用。网关地址要用 `127.0.0.1`。
- **修改配置没出现**：检查 `--workbuddy-config` 是否指向当前客户端使用的文件，必要时完全退出后重开 WorkBuddy。
- **网络搜索等功能仍有其他费用**：本项目接管配置到本网关的模型请求；WorkBuddy 内置联网服务、连接器等功能按它们自身的规则运行。

## 接口与验证范围

WorkBuddy 侧采用 OpenAI 兼容的 `/v1/chat/completions` 接口，配置完整 URL 并保持 `useCustomProtocol: false`；该开关仅影响地址补全。无需把 WorkBuddy 改成 Anthropic 协议。

验证步骤与边界见 [VALIDATION.md](VALIDATION.md)。离线测试覆盖协议转换、请求生命周期和配置恢复；账号权限、网络连通性及 WorkBuddy 实际文件操作需要在使用环境中单独验证。

可以运行 `node verify-live.mjs` 重复真实工具往返测试；该命令会消耗少量 Codex 额度。离线回归运行 `npm test`，不会调用模型。

当前支持文本、用户图片输入、函数工具、多工具调用、文本工具结果、JSON 输出和流式响应。音频/视频、带图片的工具结果、旧式 `functions` 接口和自定义 `stop` 序列不支持，会明确报错。后端不接受 `temperature`、`top_p`、`max_tokens` 等参数，网关不转发它们，输出长度按模型行为与请求超时限制。推理续轮缓存只保存在内存，重启后不会恢复。

登录凭据由网关只读使用；过期刷新交给 Codex 原生 app-server，网关自身不改写凭据文件。相关官方协议：[Codex app-server 身份认证](https://learn.chatgpt.com/docs/app-server#authentication-modes)。

官方接入说明：[WorkBuddy 模型配置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)、[WorkBuddy AI 接口要求与能力配置](https://intl.cloud.tencent.com/document/product/1316/84496)。
