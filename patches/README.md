# patches/

本目录是**上游插件 `dsh-our-free-model`（MIT，作者 Ebony-Vinyl）修改后的文件**中的一部分，
用于把「果办OfficeAce」渠道落到安装目录：

| 本目录文件 | 安装位置 |
|---|---|
| `client.js` | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-our-free-model\client.js` |
| `index.js`  | `…\dsh-our-free-model\index.js` |
| `NOTICE.md` | `…\dsh-our-free-model\vendor\channel-pack\NOTICE.md` |

## 为什么没有 `pack.js`

`vendor/channel-pack/pack.js`（约 2.9 MB）**未包含在此仓库**，原因：

1. 它是上游打包产物，非本仓库原创；
2. 其中**内嵌了上游 Gemini 渠道所用的 Google OAuth 客户端 ID/密钥**，GitHub 的
   *push protection / secret scanning* 会拒绝含该密钥的推送。

需要时请自行从上游安装包取 `pack.js`，按 [`../README.md`](../README.md) §3 的说明打补丁
（核心是在 `OfficeAceAdapter` 附近新增 `OfficeAceAuth`、V11 签名与额度/领取函数，
并把 `account.create`/`account.refresh`/`credits.*` 的 `officeace` 分支指过去）。

> 上游包为 **MIT** 许可；本目录内容是对其的修改版，同样沿用 MIT，版权归原作者。
> 替换前建议先备份原文件。
