#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「果办OfficeAce」渠道重新打进 dsh-our-free-model 插件。

用途：插件自动更新会覆盖 pack.js / client.js，本渠道会失效。
      更新后跑一次本脚本即可恢复（幂等：已打过的会被跳过）。

用法：
  python apply-officeace.py                 # 默认路径；自动备份；打补丁
  python apply-officeace.py --check         # 只检查（dry-run，不写入）
  python apply-officeace.py --plugin <dir>  # 指定插件安装目录

默认插件目录：
  %USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\dsh-our-free-model
"""

import argparse
import os
import shutil
import sys
import time

try:  # Windows 控制台可能是 GBK，强制 UTF-8 输出，避免中文/emoji 报错
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PLUGIN = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop",
                              "node_modules", "dsh-our-free-model")

PACK_REL = os.path.join("vendor", "channel-pack", "pack.js")
CLIENT_REL = "client.js"


def load_block(name):
    with open(os.path.join(HERE, "blocks", name), encoding="utf-8") as f:
        return f.read()


class Applier:
    def __init__(self, dry):
        self.dry = dry
        self.results = []          # (status, name, detail)

    def record(self, status, name, detail=""):
        self.results.append((status, name, detail))

    def edit(self, doc, name, old, new, marker=None):
        """在 doc 上做一次替换。返回新的 doc。
        marker 命中 => 视为“已经打过”（跳过）。"""
        if marker is not None and marker in doc:
            self.record("skip", name, "已应用")
            return doc
        cnt = doc.count(old)
        if cnt != 1:
            self.record("FAIL", name, "锚点命中 %d 次（期望 1）" % cnt)
            return doc
        self.record("ok", name)
        return doc.replace(old, new, 1)


def apply_pack(a, pack, blocks):
    auth_block = blocks["officeace-auth.js"]
    credits_block = blocks["officeace-credits.js"]

    # 1) ALL_PRODUCTS 去掉 OFFICEACE（历史改动，避免 productById 崩溃）
    pack = a.edit(pack, "ALL_PRODUCTS 去掉 OFFICEACE",
                  "var ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY, OFFICEACE];",
                  "var ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY];",
                  marker="var ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY];")

    # 2) 插入 OfficeAce 登录模块
    anchor1 = ("function registerOfficeAceLlm(ctx, options) {\n"
               "  const adapter = new OfficeAceAdapter(options);\n"
               "  registerAdapterIdempotent(ctx.llm, [OFFICEACE_PROVIDER], adapter);\n"
               "  return adapter;\n"
               "}")
    pack = a.edit(pack, "插入 OfficeAce 登录模块", anchor1, anchor1 + auth_block,
                  marker="var OfficeAceAuth = class")

    # 3) 插入 额度/领取 模块
    anchor2 = ('function officeAceBasicAuth(appKey, appSecret) {\n'
               '  return "Basic " + btoa(appKey + ":" + appSecret);\n'
               '}\n')
    pack = a.edit(pack, "插入 OfficeAce 额度/领取模块", anchor2, anchor2 + credits_block,
                  marker="function signOfficeAceV11")

    # 4) 适配器：凭据检查（首次）
    pack = a.edit(pack, "适配器-凭据检查(首次)",
                  '    if (credential === void 0 || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {\n'
                  '      throw new LlmError2("officeace: no usable credential; log in first", "MISSING_CREDENTIAL");\n'
                  '    }',
                  '    if (credential === void 0 || !credential.model_app_key || !credential.model_app_secret) {\n'
                  '      throw new LlmError2("officeace: no usable credential; log in first", "MISSING_CREDENTIAL");\n'
                  '    }',
                  marker='!credential.model_app_key || !credential.model_app_secret) {\n      throw new LlmError2("officeace: no usable')

    # 5) 适配器：认证失败重试后的凭据检查
    pack = a.edit(pack, "适配器-凭据检查(重试后)",
                  '          if (credential === void 0 || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {\n'
                  '            throw new LlmError2("officeace: credential missing after refresh; log in again", "MISSING_CREDENTIAL");\n'
                  '          }',
                  '          if (credential === void 0 || !credential.model_app_key || !credential.model_app_secret) {\n'
                  '            throw new LlmError2("officeace: credential missing after refresh; log in again", "MISSING_CREDENTIAL");\n'
                  '          }',
                  marker='!credential.model_app_key || !credential.model_app_secret) {\n            throw new LlmError2("officeace: credential missing')

    # 6)+7)+8) 适配器：URL 取自凭据 + 关闭 benefit + Basic 鉴权（合并为一块，锚点含唯一 URL 行）
    old_url = "    const url = `${OFFICEACE_CHAT_API_BASE}/chat/completions`;"
    new_url = "    const url = `${credential.model_api_url_base || OFFICEACE_CHAT_API_BASE}/chat/completions`;"
    if "const url = `${credential.model_api_url_base || OFFICEACE_CHAT_API_BASE}/chat/completions`;" in pack:
        a.record("skip", "适配器-URL/签名/Basic", "已应用")
    else:
        pack = a.edit(pack, "适配器-URL", old_url, new_url)
        old_req = (
            "    let response;\n"
            "    let queueAttempts = 0;\n"
            "    let authRefreshed = false;\n"
            "    let benefitHeaderDropped = false;\n"
            "    const rateLimitTried = /* @__PURE__ */ new Set();\n"
            "    if (currentAccountId) rateLimitTried.add(currentAccountId);\n"
            "    const isBenefitModel = isCodeArtsBenefitModel(options.model);\n"
            "    for (; ; ) {\n"
            "      const extraSignedHeaders = isBenefitModel && !benefitHeaderDropped ? { maas_type: \"benefit\" } : void 0;\n"
            "      const signed = await signRequestHuawei(\n"
            "        credential.access_key_id,\n"
            "        credential.secret_access_key,\n"
            "        credential.security_token,\n"
            "        \"POST\",\n"
            "        url,\n"
            "        new TextEncoder().encode(body),\n"
            "        extraSignedHeaders\n"
            "      );\n"
            "      const headers = new Headers(attributionHeaders());\n"
            "      signed.forEach((value, key) => {\n"
            "        if (key !== \"content-type\") headers.set(key, value);\n"
            "      });\n"
            "      headers.set(\"Content-Type\", \"application/json\");")
        new_req = (
            "    let response;\n"
            "    let queueAttempts = 0;\n"
            "    let authRefreshed = false;\n"
            "    let benefitHeaderDropped = false;\n"
            "    const rateLimitTried = /* @__PURE__ */ new Set();\n"
            "    if (currentAccountId) rateLimitTried.add(currentAccountId);\n"
            "    const isBenefitModel = false;\n"
            "    for (; ; ) {\n"
            "      const headers = new Headers(attributionHeaders());\n"
            "      headers.set(\"Authorization\", officeAceBasicAuth(credential.model_app_key, credential.model_app_secret));\n"
            "      headers.set(\"Content-Type\", \"application/json\");")
        pack = a.edit(pack, "适配器-Basic 鉴权", old_req, new_req)

    # 9) 适配器：模型清单用 OfficeAce 自己的
    pack = a.edit(pack, "适配器-模型清单",
                  '  providerInfo(provider) {\n'
                  '    const id = typeof provider === "string" && provider.length > 0 ? provider : OFFICEACE_PROVIDER;\n'
                  '    return { id, name: "果办OfficeAce" };\n'
                  '  }\n',
                  '  providerInfo(provider) {\n'
                  '    const id = typeof provider === "string" && provider.length > 0 ? provider : OFFICEACE_PROVIDER;\n'
                  '    return { id, name: "果办OfficeAce" };\n'
                  '  }\n'
                  '  listAllModels() {\n'
                  '    return OFFICEACE_DEFAULT_MODELS.map((id) => ({ id, name: id }));\n'
                  '  }\n',
                  marker="return OFFICEACE_DEFAULT_MODELS.map((id) => ({ id, name: id }));")

    # 10) 接线：签名/调用处加 officeaceAuth
    pack = a.edit(pack, "接线-函数签名+调用",
                  ", officeace, buddy, workbuddy, lobsterai, qoder",
                  ", officeace, officeaceAuth, buddy, workbuddy, lobsterai, qoder",
                  marker=", officeace, officeaceAuth, buddy, workbuddy, lobsterai, qoder")
    pack = a.edit(pack, "接线-Endpoints 实参表",
                  "      officeace,\n      buddy,\n",
                  "      officeace,\n      officeaceAuth,\n      buddy,\n",
                  marker="      officeace,\n      officeaceAuth,\n")
    pack = a.edit(pack, "接线-实例化 OfficeAceAuth",
                  "  const service = new CodeArtsAuth(ctx);\n  const pool = new AccountPool(ctx);",
                  "  const service = new CodeArtsAuth(ctx);\n  const officeaceAuth = new OfficeAceAuth(ctx);\n  const pool = new AccountPool(ctx);",
                  marker="const officeaceAuth = new OfficeAceAuth(ctx);")
    pack = a.edit(pack, "接线-account.create",
                  '        } else if (provider === "officeace") {\n          const started = await codearts.startLogin({ refName });',
                  '        } else if (provider === "officeace") {\n          const started = await officeaceAuth.startLogin({ refName });',
                  marker='} else if (provider === "officeace") {\n          const started = await officeaceAuth.startLogin({ refName });')
    pack = a.edit(pack, "接线-account.refresh(第一处)",
                  '            case "officeace":\n              await codearts.refreshAccountCredential(entry.credentialRef, pool, entry.id);',
                  '            case "officeace":\n              await officeaceAuth.refreshAccountCredential(entry.credentialRef, pool, entry.id);',
                  marker='case "officeace":\n              await officeaceAuth.refreshAccountCredential')

    # 11) credits.balances：officeace 分支（查订阅额度）
    pack = a.edit(pack, "credits.balances 分支",
                  '      case "credits.balances": {\n        const req = payload;\n        const accounts = await pool.listAccounts(req.provider);\n',
                  '      case "credits.balances": {\n        const req = payload;\n        const accounts = await pool.listAccounts(req.provider);\n'
                  '        if (req.provider === "officeace") {\n'
                  '          const values2 = [];\n'
                  '          for (const account of accounts) {\n'
                  '            const resolved = await ctx.credentials.resolve(credentialRef13(account.credentialRef));\n'
                  '            let credential;\n'
                  '            try { credential = resolved ? JSON.parse(resolved.value) : void 0; } catch { credential = void 0; }\n'
                  '            if (!credential || !credential.access_key_id) { values2.push({ accountId: account.id, nickname: account.nickname, balance: null, error: "凭据未配置" }); continue; }\n'
                  '            try {\n'
                  '              const sub = await fetchOfficeAceSubscription(credential, fetch);\n'
                  '              values2.push({ accountId: account.id, nickname: account.nickname, balance: mapOfficeAceBalance(sub) });\n'
                  '            } catch (error) {\n'
                  '              values2.push({ accountId: account.id, nickname: account.nickname, balance: null, error: "额度查询失败：" + String(error?.message ?? error) });\n'
                  '            }\n'
                  '          }\n'
                  '          return { ok: true, value: { accounts: values2 } };\n'
                  '        }\n',
                  marker="balance: mapOfficeAceBalance(sub) })")

    # 13) credits.claimAll：officeace 分支（领奖励）
    pack = a.edit(pack, "credits.claimAll 分支",
                  '      case "credits.claimAll": {\n        const req = payload;\n        const accounts = await pool.listAccounts(req.provider);\n',
                  '      case "credits.claimAll": {\n        const req = payload;\n        const accounts = await pool.listAccounts(req.provider);\n'
                  '        if (req.provider === "officeace") {\n'
                  '          const value2 = await collectClaimResults(accounts, void 0, {\n'
                  '            resolve: (ref) => ctx.credentials.resolve(ref),\n'
                  '            claim: (credential) => officeAceClaimOutcome(credential),\n'
                  '            precheckStatus: false,\n'
                  '            warn: (msg) => ctx.logger?.warn?.(msg)\n'
                  '          });\n'
                  '          return { ok: true, value: value2 };\n'
                  '        }\n',
                  marker="claim: (credential) => officeAceClaimOutcome(credential)")

    return pack


def apply_client(a, client):
    # 渠道卡片（若缺则补在 codearts 之后）
    anchor = "{ id: 'codearts',  name: 'CodeArts', org: '华为云', accent: '#C7000B', note: 'DeepSeek · GLM · openPangu，每日免费额度', login: 'browser' },"
    if "id: 'officeace'" in client:
        a.record("skip", "client-CHANNEL_PROVIDERS", "已存在")
    else:
        cnt = client.count(anchor)
        if cnt != 1:
            a.record("FAIL", "client-CHANNEL_PROVIDERS", "锚点命中 %d 次" % cnt)
        else:
            entry = "\n      { id: 'officeace', name: '果办OfficeAce', org: '华为云', accent: '#C7000B', note: '华为账号登录 · DeepSeek · GLM · openPangu 免费额度', login: 'browser' },"
            client = client.replace(anchor, anchor + entry, 1)
            a.record("ok", "client-CHANNEL_PROVIDERS")
    # 积分/领取能力
    anchor_credits = "      gemini: { unit: 'quota', quota: true },\n    }"
    if "officeace: { claim: true }" in client:
        a.record("skip", "client-CHANNEL_CREDITS", "已存在")
    else:
        cnt = client.count(anchor_credits)
        if cnt != 1:
            a.record("FAIL", "client-CHANNEL_CREDITS", "锚点命中 %d 次" % cnt)
        else:
            client = client.replace(anchor_credits, "      gemini: { unit: 'quota', quota: true },\n      officeace: { claim: true },\n    }", 1)
            a.record("ok", "client-CHANNEL_CREDITS")
    return client


def main():
    ap = argparse.ArgumentParser(description="将 果办OfficeAce 渠道打入 dsh-our-free-model")
    ap.add_argument("--check", action="store_true", help="只检查，不写入")
    ap.add_argument("--plugin", default=DEFAULT_PLUGIN, help="插件安装目录")
    args = ap.parse_args()

    plugin = os.path.abspath(args.plugin)
    pack_path = os.path.join(plugin, PACK_REL)
    client_path = os.path.join(plugin, CLIENT_REL)

    if not os.path.isfile(pack_path) or not os.path.isfile(client_path):
        print("[ERROR] 找不到插件文件：\n  %s\n  %s\n请用 --plugin 指定正确目录。" % (pack_path, client_path))
        return 2

    blocks = {"officeace-auth.js": load_block("officeace-auth.js"),
              "officeace-credits.js": load_block("officeace-credits.js")}

    a = Applier(args.check)
    with open(pack_path, encoding="utf-8") as f:
        pack = f.read()
    with open(client_path, encoding="utf-8") as f:
        client = f.read()

    print("插件目录：%s\n" % plugin)
    new_pack = apply_pack(a, pack, blocks)
    new_client = apply_client(a, client)

    print("%-4s %-34s %s" % ("结果", "步骤", "说明"))
    print("-" * 76)
    fail = False
    for status, name, detail in a.results:
        print("%-4s %-34s %s" % (status, name, detail))
        if status == "FAIL":
            fail = True

    if args.check:
        print("\n[dry-run] 未写入任何文件。")
        return 1 if fail else 0

    if fail:
        print("\n[ABORT] 有步骤未成功（上游结构可能变了）。已改动内容**未写入**。")
        print("       请把上面 FAIL 的行发我，我帮你重新对齐锚点。")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    for path, content in ((pack_path, new_pack), (client_path, new_client)):
        shutil.copy2(path, path + ".officeace-bak-" + stamp)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
    print("\n[OK] 已写入，并备份为 *.officeace-bak-%s\n     重启 dsh 即可。" % stamp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
