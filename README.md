# pi-workbuddy-connect

> ## 给 Agent 的安装指令（把这段原样发给你的 Agent）
>
> ```text
> 请把这台机器上的 Pi Agent CLI 接上 WorkBuddy 模型：
>
> 1. 确认已安装 pi：运行 `pi --version`（需 1.3.x）。没有就先按 https://pi.dev 安装。
> 2. 安装本扩展（SSH）：
>    pi install git:git@github.com:longge1213812138/pi-workbuddy-connect.git
>    若 SSH 不通，改用 HTTPS：
>    pi install git:https://github.com/longge1213812138/pi-workbuddy-connect.git
> 3. 不要修改本机已登录的 WorkBuddy 桌面 App，也不要读取或打印它的凭据内容；
>    本扩展只需读取 App 的登录状态，凭据不会被复制出本机。
> 4. 验证：运行 `pi --list-models`，应出现 `workbuddy` 分组（登录了 WorkBuddy AI 国际版时还会有 `workbuddy-ai`）。
> 5. 若第 4 步没有出现分组，运行一次 `pi`，在交互界面执行 `/workbuddy doctor` 并把它输出的诊断信息发给我。
>    常见原因：桌面 App 未登录、Linux 下需要显式指定解密程序（WORKBUDDY_ELECTRON_BIN）。
> ```
>
> 仓库地址：<https://github.com/longge1213812138/pi-workbuddy-connect>
把已登录的 **WorkBuddy / WorkBuddy AI** 桌面 App 中可用的模型接入 **Pi Agent CLI**（`/model` 模型选择器、`/thinking` 推理档位、图片输入、余额状态栏、档位检测、按账号模型显隐）。

这是 `dsh-workbuddy-connect`（DeepSeek Harness 插件）功能在 Pi 上的**原生 Provider 实现**：零额外配置，直接复用桌面 App 的登录状态，账号切换自动跟随，国内版与国际版互不影响。

```
WorkBuddy 私有 API
   ⇅  vendor/workbuddy-core.mjs（0.7.8 核心：凭据读取/解密、token 刷新、UA 矩阵、上游客户端、目录解析、探测核心）
src/stream.ts（零依赖 OpenAI SSE 组包与解析：消息、工具调用、图片、用量、中止）
   ⇅  src/fetch-adapter.ts（唯一新增协议代码：prepareChatBody + chatStream）
pi.registerProvider(完整 Provider)  →  /model、/thinking、会话
```

上游 `chatStream()` 成功时返回的响应**已是 OpenAI Chat Completions SSE**，因此本实现**不运行任何本地 HTTP 服务**，loopback shim 被 fetch 适配器取代。

**为什么流式层是自己写的**：Pi 不为 git 来源的包安装依赖，而 pi-ai 又是宿主提供的包（文档明确要求不得在 `dependencies` 里物理复制）。所以扩展只通过 `import type` 依赖 pi-ai（运行时被擦除），流式与目录/认证逻辑全部由本包自带，安装后**不需要任何 `node_modules`**——`pi install git:…`、`pi install npm:…`、`pi -e` 三种方式行为一致。

## 安装

前置：Node ≥ 22.19；本机已安装并登录 WorkBuddy（国内版）或 WorkBuddy AI 桌面 App。

```sh
# 从 GitHub 安装（推荐）
pi install git:git@github.com:longge1213812138/pi-workbuddy-connect.git
# SSH 不通时用 HTTPS
pi install git:https://github.com/longge1213812138/pi-workbuddy-connect.git

# 或从本地目录安装
pi install ./pi-workbuddy-connect

# 仅本次试用（不写入设置）
pi -e ./pi-workbuddy-connect
```

安装后 Pi 会自动加载扩展，无需手动跑 `npm install`（宿主提供 `@earendil-works/pi-ai`，其余无运行时依赖）。

验证：`pi --list-models` 出现 `workbuddy` / `workbuddy-ai` 分组（只登录一版就只出现一组），从分组里选一个模型完成一次简短对话即算成功。

> 加密桌面凭据（WorkBuddy 5.6+）的解密程序在 macOS / Windows 上自动探测；探测失败时用 `WORKBUDDY_ELECTRON_BIN`（国际版 `WORKBUDDY_AI_ELECTRON_BIN`）显式指定桌面 App 的可执行文件。Linux 需显式指定。凭据文件位置可用 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 覆盖。

## 用法

### 模型与档位

- `/model`：出现「WorkBuddy」「WorkBuddy AI」分组，模型名后带积分倍率与促销徽章（如 `GLM-5.2 · x0.79`、`Hy4 preview · x0.00 · 限时免费`）；促销过期后徽章撤销，折后价无法还原时显示「价格未知」。
- `/thinking`：显示模型声明的推理档位（如 GLM-5.3 的 low / high / max）。未声明档位的模型默认不提供档位选择，可用 `/workbuddy probe` 检测（见下）。
- 图片：仅上游声明支持图片的模型接受粘贴/拖入图片（GLM-5.1 / GLM-5.2 等纯文本模型会拒绝）。
- 状态栏：选中 WorkBuddy 模型时显示剩余积分（`WB · 3,401 积分` / `WB AI · …`）。不自动轮询——每次读取都是真实计费查询，`/workbuddy balance` 手动刷新。

### `/workbuddy` 命令

| 命令 | 说明 |
|---|---|
| `/workbuddy status [--json]` | 登录状态、账号、令牌有效期、积分（企业账号含周期额度）、目录来源与更新时间、档位来源统计 |
| `/workbuddy balance` | 手动重读积分 |
| `/workbuddy refresh` | 强制刷新模型目录 |
| `/workbuddy doctor [--json]` | 环境诊断：凭据路径/格式、解密程序解析、上游连通、状态目录 |
| `/workbuddy logout` | 删除本包自留的凭据副本（桌面 App 登录不动；`auth.json` 标记用 pi 的 `/logout` 移除） |
| `/workbuddy hide\|show <model>` | 模型显隐，按登录账号分别保存 |
| `/workbuddy probe <model>` | 推理档位检测（见下）；`--clear` 清空检测记录 |
| `/workbuddy max-context on\|off` | 国际版「使用上游声明的最大上下文窗口」（默认开，持久化） |

以上均支持 `--provider workbuddy|workbuddy-ai` 选择变体（默认国内版）。

### 推理档位检测（`probe`）

WorkBuddy 的档位信息分散在上游接口与客户端私有 UI 逻辑中，且部分模型接受 `reasoning_effort` 参数却忽略未知值。因此对未声明档位的模型采用**用户逐次授权**的动态检测：先验证上游确实校验该参数（哨兵值），再逐档确认哪些规范档位被接受。检测会发送少量请求、可能消耗积分；结果仅表示上游当前接受该档位，不承诺一定改变推理效果、速度或积分消耗。结果按「账号 × 模型指纹」保存 14 天，模型目录行变化或 TTL 过期即自动失效。

## 行为边界

- **无凭据即隐藏**：某版 App 从未登录（或登录失效）时该分组不出现，不展示必然失败的模型；重新登录后无需重启即恢复。
- **显隐只影响选择器**：正在使用该模型的会话不受影响；新账号与新上架模型默认显示。
- **两级降级**：断网或上游失败时按「本账号上次成功目录 → 内置兜底表」降级，`/workbuddy status` 标注来源与失败原因。
- **账号隔离**：目录、显隐、检测记录均按 `uid:enterpriseId` 键控；切回账号恢复各自配置；检测中途换账号会丢弃结果。
- **CN / 国际差异**：CN 独有的 `onlyReasoning` 模型不提供 `off` 档；目录按 UA 分流；企业计费仅国内版验证（国际版企业账号按个人接口读取，未实测）。
- **不轮询积分**：余额仅在选中模型与手动命令时读取。
- **状态目录**：`~/.pi/agent/workbuddy/`（可用 `PI_CODING_AGENT_DIR` 改根），原子写 + `0o600`，损坏文件读作空。桌面 App 的凭据文件**只读**，token 刷新只写本包副本。

## 开发

```sh
npm run typecheck   # tsc --noEmit（strict）
npm test            # vitest（7 个测试文件，72 个用例）
```

测试全部走注入假件与临时目录，不触碰真实凭据、不发真实请求；`tests/smoke.test.ts` 用 stub ExtensionAPI 走完整装配链路。

### 升级 vendored 核心

`vendor/workbuddy-core.mjs` 来自 `dsh-workbuddy-connect@0.7.8` 的 `lib/host-heartbeat-*.js`（打包产物），改动仅有一处：`@deepseek-ai/dsh-home-paths` 的 import 被内联为 `resolveDshHome`。升级步骤：下载新版 → 复制并施加同一处替换 → 更新 `vendor/workbuddy-core.d.mts` 与 `THIRD_PARTY_NOTICES.txt` 的版本号 → 跑测试。

## 已知限制

- 依赖 WorkBuddy 客户端私有接口（非官方开放 API），上游更新后可能需要跟随调整（含拒绝码词汇表变化，见上游 issue #143/#148）。
- 企业账号计费分支仅国内版；国际版企业账号未实测。
- WSL 下调用 Windows 解密程序的环境转发沿用上游实现，尚未在 WSL2 真机验证。
- UI 形态为 TUI 等效方案（状态栏 + 命令输出），不复刻 DSH Web 设置卡片。
- 心跳文件未实现（扩展与 Pi 同进程，`doctor` 覆盖诊断意图）。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 本项目与腾讯、WorkBuddy、DeepSeek、Pi 均无关联，未获其授权或认可；文中名称仅用于描述兼容关系。
- 私有接口无稳定性或兼容性承诺。

## 致谢与许可

- 核心（凭据/协议/目录/探测）vendored 自 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT），改动见 `THIRD_PARTY_NOTICES.txt`。
- 协议参照 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）。

本包其余代码以 MIT 发布。
