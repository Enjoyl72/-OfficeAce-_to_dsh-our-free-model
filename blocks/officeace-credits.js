
// ── OfficeAce 额度 / 每日领取（华为云 MaaS 订阅接口，V11-HMAC-SHA256 签名）──
var OFFICEACE_REGION = "cn-southwest-2";
function officeAceJenc(e) {
  return encodeURIComponent(e).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function officeAceCanonPath(u) {
  let r = (u.pathname || "/").split("/").map((n) => officeAceJenc(decodeURIComponent(n))).join("/");
  if (!r.endsWith("/")) r += "/";
  return r;
}
function officeAceCanonQuery(u) {
  const t = [];
  u.searchParams.forEach((v, k) => t.push([k, v]));
  t.sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]));
  return t.map((p) => officeAceJenc(p[0]) + "=" + officeAceJenc(p[1])).join("&");
}
async function hmacSha256Raw(key, data) {
  const cryptoKey = await crypto.subtle.importKey("raw", key.slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data.slice().buffer);
  return new Uint8Array(sig);
}
async function signOfficeAceV11(ak, sk, securityToken, method, urlStr, headersIn, bodyText) {
  const u = new URL(urlStr);
  const h = {};
  for (const [k, v] of Object.entries(headersIn ?? {})) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const dateStamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  h["x-sdk-date"] = dateStamp;
  h["host"] = h["host"] || u.host;
  if (securityToken) h["x-security-token"] = securityToken;
  const names = Object.keys(h).sort();
  const payloadHash = await sha256Hex(new TextEncoder().encode(bodyText ?? ""));
  const canonicalHeaders = names.map((k) => k + ":" + h[k]).join("\n") + "\n";
  const canonical = [method.toUpperCase(), officeAceCanonPath(u), officeAceCanonQuery(u), canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const scope = dateStamp.substring(0, 8) + "/" + OFFICEACE_REGION + "/apic";
  const stringToSign = ["V11-HMAC-SHA256", dateStamp, scope, await sha256Hex(new TextEncoder().encode(canonical))].join("\n");
  const k1 = await hmacSha256Raw(new TextEncoder().encode(ak), new TextEncoder().encode(sk));
  const scopeBytes = new TextEncoder().encode(scope);
  const msg2 = new Uint8Array(scopeBytes.length + 1);
  msg2.set(scopeBytes, 0);
  msg2[scopeBytes.length] = 1;
  const derived = (await hmacSha256Raw(k1, msg2)).slice(0, 32);
  const derivedHex = Array.from(derived).map((b) => b.toString(16).padStart(2, "0")).join("");
  const signature = await hmacSha256Hex(new TextEncoder().encode(derivedHex), new TextEncoder().encode(stringToSign));
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = v;
  out.Authorization = "V11-HMAC-SHA256 Credential=" + ak + "/" + scope + ", SignedHeaders=" + names.join(";") + ", Signature=" + signature;
  return out;
}
function officeAceApiOrigin(credential) {
  const base = String(credential?.model_api_url_base || OFFICEACE_CHAT_API_BASE);
  return base.replace(/\/v2\/?$/, "").replace(/\/+$/, "");
}
async function fetchOfficeAceSubscription(credential, fetcher = fetch) {
  const url = officeAceApiOrigin(credential) + "/v1/subscription";
  const headers = await signOfficeAceV11(credential.access_key_id, credential.secret_access_key, credential.security_token, "GET", url, { "x-subscription-type": "v2" }, "");
  const response = await fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error("OfficeAce subscription HTTP " + response.status);
  return await response.json();
}
async function claimOfficeAceBonus(credential, fetcher = fetch) {
  const url = officeAceApiOrigin(credential) + "/v1/subscription/bonus/claim";
  const body = "{}";
  const headers = await signOfficeAceV11(credential.access_key_id, credential.secret_access_key, credential.security_token, "POST", url, { "content-type": "application/json" }, body);
  const response = await fetcher(url, { method: "POST", headers, body, signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error("OfficeAce claim HTTP " + response.status);
  const data = await response.json();
  return Array.isArray(data?.bonus_skus) ? data.bonus_skus : [];
}
function mapOfficeAceBalance(sub) {
  const packages = [];
  let total = 0;
  const add = (name, limit, used, expiresAt) => {
    const quota = Number(limit);
    const usedNum = Number(used);
    const remaining = Number.isFinite(quota) ? Math.max(0, quota - (Number.isFinite(usedNum) ? usedNum : 0)) : 0;
    total += remaining;
    packages.push({
      name,
      total: Number.isFinite(quota) ? quota : remaining,
      ...Number.isFinite(usedNum) ? { used: usedNum } : {},
      ...expiresAt ? { expiresAt } : {}
    });
  };
  for (const sku of (Array.isArray(sub?.skus) ? sub.skus : [])) {
    for (const q of (Array.isArray(sku.quotas) ? sku.quotas : [])) {
      if (q.sku_attr_code !== "officeace_points") continue;
      add(sku.sku_name || sku.sku_code || "OfficeAce", q.sku_value, q.current_value, sku.expired_time || q.expired_time);
    }
  }
  for (const b of (Array.isArray(sub?.bonus_skus) ? sub.bonus_skus : [])) {
    if (b.status !== void 0 && b.status !== "SUBSCRIBED") continue;
    add(b.activity_name || b.activity_id || "活动", b.points, b.current_value, b.expired_time);
  }
  return { total, packages };
}
async function officeAceClaimOutcome(credential, _product2, _entry, fetcher = fetch) {
  const skus = await claimOfficeAceBonus(credential, fetcher);
  if (!Array.isArray(skus) || skus.length === 0) return { kind: "already-claimed", message: "今日无可领奖励" };
  const credit = skus.reduce((sum, s) => sum + (Number(s.points) || 0), 0);
  return { kind: "claimed", credit, message: "已领取" };
}
