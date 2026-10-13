# 给 dsh-our-free-model 加一条「果办OfficeAce」免费渠道

> 本文记录一次完整的逆向 + 实现过程：在 dsh 插件
> [`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) 里新增一条
> **果办OfficeAce**（华为云 AgentArts 平台）渠道，并做到**完全不需要运行 OfficeAce 客户端**。
>
> 实现日期：2026-10-13 · 环境：Windows 11 · dsh 桌面版 0.2.0-rc.2 · 插件 2.1.0

---

## 1. 背景与目标

`dsh-our-free-model` 是给 dsh（DeepSeek Harness）用的"白嫖模型聚合"插件，内置十三个账号渠道
（CodeArts、CodeBuddy/WorkBuddy、LobsterAI、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax Code、
ZCode、Gemini 等）。每个渠道的玩法是：**用你各自产品的账号登录，把它的免费额度接进 dsh**。

**目标**：再加一条「果办OfficeAce」渠道，且功能要齐全（登录 / 模型 / 对话 / **积分** / **每日领取**）。

**关键约束**（用户诉求）：**不想每次都开着 OfficeAce 客户端**。

---

## 2. 逆向：OfficeAce 是怎么登录和调模型的

OfficeAce 客户端（`果办OfficeAce`，v1.3.4）是 Electron 应用，装在 `E:\SoftwarePC\果办\OfficeAce`：

- `OfficeAce.exe` —— Electron 前端
- `packages/api/dist/cli.js`（`tools/node/node.exe` 运行）—— **本机后端**，监听 `https://127.0.0.1:3004`（自签名证书）
- 云后端 `https://api.office-claw.com`
- 数据目录 `~/.office-claw/`

### 2.1 它是怎么做鉴权的

从 `packages/api/node_modules/@office-claw/green-package/dist/auth/huawei-oauth.js` 读出完整流程：

```
1) state      POST https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/state
2) 授权       GET  https://auth.huaweicloud.com/authui/v1/oauth2/authorize
                  ?client_id=pdp5_for_agentarts & code_challenge=… & state=… & scope=openid
                  & redirect_uri=… & response_type=code          (外层再套 authui/login.html?service=…)
3) 换 token   POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
                  body: { client_id, code, code_verifier, grant_type=authorization_code, redirect_uri }
                  header: DPoP: <ES256 JWT>
              → { credentials: { access_key_id, secret_access_key, security_token, expiration },
                  refresh_token }
4) 取网关密钥 POST https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-subscription   (AK/SK 签名)
              → { model_info: { model_auth_info: { model_app_key, model_app_secret, maas_api_key },
                                model_api_url_base } }
5) 发对话     POST https://<model_api_url_base>/v2/chat/completions
              header: Authorization: Basic base64(model_app_key:model_app_secret)
```

**两个决定性的发现：**

1. **回调可以落到本机**。`pdp5_for_agentarts` 这个 OAuth 客户端**接受本机 `redirect_uri`**
   （实测 `http://127.0.0.1:<port>/oauth/callback` 能收到 `code`）——所以插件可以像 CodeArts 一样
   自己开端口收回调，**不需要 OfficeAce 客户端**（也不需要 `officeace://` 自定义协议）。
2. **换 token 用的是和 CodeArts 完全相同的 STS 接口**，返回的凭据形状
   （`access_key_id` / `secret_access_key` / `security_token` + `refresh_token`）也一模一样。

### 2.2 额度与「每日领取」

积分**不在**登录响应或对话响应里，而在**华为云 MaaS 的订阅接口**上，用 **V11-HMAC-SHA256** 签名
（算法实现在 `packages/api/dist/chunk-XOTX5NN5.js`）：

```
GET  https://<origin>/v1/subscription                      header: x-subscription-type: v2
POST https://<origin>/v1/subscription/bonus/claim          header: content-type: application/json  body: {}
```

- `/v1/subscription` 返回 `skus[].quotas[]`（`officeace_points` = 主积分）**和 `bonus_skus[]`**
  （各种活动积分池：新用户专属福利、每日签到有礼、国庆黄金周·登录翻倍礼 …）。
- `/v1/subscription/bonus/claim` 领取奖励；**必须带 `Content-Type: application/json` 且 body 为 `{}`**，
  否则返回 500。

V11 签名的要点：`x-sdk-date`、`x-security-token` 头；规范串
`V11-HMAC-SHA256\n<dateStamp>\n<scope>\n<sha256(canonicalRequest)>`，`scope = <date[0:8]>/cn-southwest-2/apic`；
密钥派生 `derived = HMAC(HMAC(ak, sk), scope‖0x01)`，`signature = HMAC(derived, stringToSign)`。

---

## 3. 实现

改动都落在安装目录 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-our-free-model\`。

### 3.1 `vendor/channel-pack/pack.js`（核心）

- **新增 `OfficeAceAuth` 服务**（独立于 `CodeArtsAuth`）：
  - `startOfficeAceOAuthFlow()`：取云端 state → PKCE + DPoP 密钥对 → 起本机回调服务 → 组装授权 URL
  - `officeAceExchangeCode()` / `officeAceExchangeRefresh()`：复用既有的 `requestToken`（同一个 STS 端点）
  - `persistLogin()`：登录后**再调 `client-subscription` 取网关密钥**，与凭据一起落库
  - `refreshAccountCredential()`：用 refresh_token 续期，并重取订阅密钥
- **新增额度/领取函数**：`signOfficeAceV11()`、`fetchOfficeAceSubscription()`、
  `claimOfficeAceBonus()`、`mapOfficeAceBalance()`（汇总 `skus[].quotas[]` + `bonus_skus[]`）
- **改写 `OfficeAceAdapter`**：请求头由 **AK/SK HMAC** 改成 **`Authorization: Basic`**，
  网关 URL 取自凭据里的 `model_api_url_base`（自动补 `/v2`），模型清单用 OfficeAce 自己的模型
- **接线**：`account.create` / `account.refresh` 的 `officeace` 分支指向 `OfficeAceAuth`；
  `credits.balances` / `credits.claimAll` 的 `officeace` 分支接真实订阅接口

### 3.2 `client.js`

- 修复 officeace 的图标（base64 截断）与 `CHANNEL_ICONS` 收尾
- `CHANNEL_PROVIDERS` 加 officeace 卡片；`CHANNEL_CREDITS` 加 `officeace: { claim: true }`

### 3.3 其它

- `index.js` / `vendor/channel-pack/NOTICE.md`：渠道数 13 → 14
- 删除 `account.refresh` 里重复的 officeace 死分支

---

## 4. 验证（全部实测通过）

| 环节 | 结果 |
|---|---|
| 本机回调收 `code` | ✅ |
| STS 换 AK/SK/ST + refresh_token | ✅ 200 |
| `client-subscription` 取 `model_app_key/model_app_secret` | ✅ 200 |
| 发对话 | ✅ 返回 `content:"连接成功"` |
| 积分（`/v1/subscription`） | ✅ 个人体验版 500 + 新用户福利 4000 + 每日签到有礼 1000 + 国庆黄金周 1000 |
| 每日领取（`bonus/claim`） | ✅ 返回 200（当日已领 → `bonus_skus: []`） |

---

## 5. 维护

**这是纯逆向实现**：OfficeAce 客户端或网关一旦更新，接口/签名可能变化，届时需要重新抓包核对
（重点：OAuth 的 `client_id` 与 `redirect_uri` 是否仍允许本机、STS/订阅接口是否变动、V11 签名参数）。

插件自身的**自动更新会覆盖 `pack.js` / `client.js`**，覆盖后本渠道会失效，需按本文档重新打补丁。

---

## 6. 声明

- 上游插件 `dsh-our-free-model` 为 **MIT** 许可，本文档及其补丁同样以 MIT 发布，并保留原作者版权。
- 本渠道仅供**用户对自己账号**的额度接入使用；上游条款与可用性可能随时变化。
