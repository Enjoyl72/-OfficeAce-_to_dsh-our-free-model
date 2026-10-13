
// ── 果办OfficeAce 专用登录（参考 CodeArts；但走 OfficeAce/AgentArts 的 OAuth，并在订阅接口取网关密钥）──
var OFFICEACE_CLIENT_ID = "pdp5_for_agentarts";
var OFFICEACE_AUTH_BASE = "https://auth.huaweicloud.com";
var OFFICEACE_CLAW_BASE = "https://agentarts.cn-southwest-2.myhuaweicloud.com";
var OFFICEACE_OAUTH_TTL_MS = 10 * 60 * 1e3;
var OFFICEACE_DEFAULT_MODELS = ["deepseek-v4.1-flash", "deepseek-v4-flash-0731", "glm-5.2", "glm-5.1"];
async function fetchOfficeAceState(fetcher = fetch) {
  const response = await fetcher(OFFICEACE_CLAW_BASE + "/v1/claw/auth/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error("OfficeAce state HTTP " + response.status);
  const data = await response.json();
  const state = typeof data?.state === "string" ? data.state.trim() : "";
  if (state.length === 0) throw new Error("OfficeAce state missing");
  return state;
}
function buildOfficeAceAuthorizeUrl(port, pkce, state) {
  const redirectUri = "http://127.0.0.1:" + port + REDIRECT_PATH;
  const inner = OFFICEACE_AUTH_BASE + "/authui/v1/oauth2/authorize?client_id=" + OFFICEACE_CLIENT_ID + "&code_challenge=" + pkce.codeChallenge + "&code_challenge_method=SHA-256&state=" + state + "&scope=openid&redirect_uri=" + encodeURIComponent(redirectUri) + "&response_type=code";
  const bg = encodeURIComponent("https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/bg2.png");
  const portal = encodeURIComponent("https://res.hc-cdn.com/AgentArts-Console/26.4.7/hws/assets/login/ad2.png");
  return OFFICEACE_AUTH_BASE + "/authui/login.html?service=" + encodeURIComponent(inner) + "&background_img_url=" + bg + "&portal_img_url=" + portal;
}
function officeAceExchangeCode(code, codeVerifier, port, keyPair, fetcher = fetch) {
  return requestToken({ client_id: OFFICEACE_CLIENT_ID, code, code_verifier: codeVerifier, grant_type: GRANT_AUTHORIZATION_CODE, redirect_uri: "http://127.0.0.1:" + port + REDIRECT_PATH }, keyPair, fetcher);
}
function officeAceExchangeRefresh(refreshToken, codeVerifier, keyPair, fetcher = fetch) {
  return requestToken({ client_id: OFFICEACE_CLIENT_ID, code_verifier: codeVerifier, grant_type: GRANT_REFRESH_TOKEN, refresh_token: refreshToken }, keyPair, fetcher);
}
function startOfficeAceCallbackServer(state, pkce, keyPair, options) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve2, reject) => {
    resolveResult = resolve2;
    rejectResult = reject;
  });
  const server = createServer((request2, response) => {
    const url = new URL(request2.url ?? "/", "http://127.0.0.1:" + request2.socket.localPort);
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("缺少授权码");
      return;
    }
    void officeAceExchangeCode(code, pkce.codeVerifier, request2.socket.localPort ?? 0, keyPair, options.fetcher).then(
      (token) => {
        const credential = credentialFromTokenResponse(token, pkce, keyPair);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>登录成功，可关闭此页。</h2>");
        resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: "" });
      },
      (error) => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("登录失败");
        rejectResult(error);
      }
    );
  });
  return listenOnCallbackPort(server).then((port) => ({ port, server, result }));
}
async function startOfficeAceOAuthFlow(options = {}) {
  const state = await fetchOfficeAceState(options.fetcher);
  const pkce = generatePkcePair();
  const keyPair = await generateDpopKeyPair();
  const { port, server, result } = await startOfficeAceCallbackServer(state, pkce, keyPair, options);
  const loginUrl = buildOfficeAceAuthorizeUrl(port, pkce, state);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve2) => server.close(() => resolve2()));
  };
  const resultWithUrl = Promise.race([
    result,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("OfficeAce OAuth login timed out")), OFFICEACE_OAUTH_TTL_MS);
      timer.unref?.();
    })
  ]).then((outcome) => ({ ...outcome, loginUrl }));
  resultWithUrl.catch(() => {
  }).finally(() => {
    void close();
  });
  return { loginUrl, result: resultWithUrl, close };
}
async function signOfficeAceRequest(ak, sk, securityToken, method, urlStr, bodyBytes, extraHeaders) {
  const url = new URL(urlStr);
  let uri = url.pathname;
  if (!uri.endsWith("/")) uri += "/";
  const query = url.search.slice(1);
  const dateStamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const payloadHash = await sha256Hex(bodyBytes);
  const headers = /* @__PURE__ */ new Map();
  headers.set("host", url.host);
  headers.set("x-sdk-date", dateStamp);
  headers.set("x-sdk-content-sha256", payloadHash);
  headers.set("x-security-token", securityToken);
  if (extraHeaders !== void 0) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key.toLowerCase(), value);
  }
  const names = [...headers.keys()].sort();
  const canonical = [method.toUpperCase(), uri, query, names.map((k) => `${k}:${headers.get(k)}`).join("\n"), "", names.join(";"), payloadHash].join("\n");
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonical));
  const stringToSign = "SDK-HMAC-SHA256\n" + dateStamp + "\n" + canonicalHash;
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign));
  const out = {};
  for (const [k, v] of headers) out[k] = v;
  out.Authorization = "SDK-HMAC-SHA256 Access=" + ak + ",SignedHeaders=" + names.join(";") + ",Signature=" + signature;
  return out;
}
function normalizeOfficeAceBase(base) {
  let value = String(base).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  if (!value.endsWith("/v2")) value = value + "/v2";
  return value;
}
async function fetchOfficeAceModelInfo(credential, fetcher = fetch) {
  const url = OFFICEACE_CLAW_BASE + "/v1/claw/client-subscription";
  const body = new TextEncoder().encode("{}");
  const headers = await signOfficeAceRequest(credential.access_key_id, credential.secret_access_key, credential.security_token, "POST", url, body, { "content-type": "application/json;charset=utf8", "x-subscription-type": "v2" });
  const response = await fetcher(url, { method: "POST", headers, body, signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error("OfficeAce subscription HTTP " + response.status);
  const payload = await response.json();
  const info = payload?.model_info ?? payload?.subscription?.model_info ?? payload?.data?.model_info ?? {};
  const auth = info.model_auth_info ?? {};
  const appKey = typeof auth.model_app_key === "string" ? auth.model_app_key.trim() : "";
  const appSecret = typeof auth.model_app_secret === "string" ? auth.model_app_secret.trim() : "";
  const base = typeof info.model_api_url_base === "string" ? info.model_api_url_base : "";
  if (appKey.length === 0 || appSecret.length === 0 || base.length === 0) throw new Error("OfficeAce model_info incomplete");
  return { appKey, appSecret, base: normalizeOfficeAceBase(base) };
}
function officeAceBasicAuth(appKey, appSecret) {
  return "Basic " + btoa(appKey + ":" + appSecret);
}
var OfficeAceAuth = class extends Service {
  active = true;
  fetchImpl = fetch;
  refreshQueues = /* @__PURE__ */ new Map();
  constructor(ctx, options = {}) {
    super(ctx, "officeAceAuth");
    if (options.fetcher) this.fetchImpl = options.fetcher;
  }
  queueFor(refName) {
    let queue = this.refreshQueues.get(refName);
    if (queue === void 0) {
      queue = new SerialQueue();
      this.refreshQueues.set(refName, queue);
    }
    return queue;
  }
  async readCredential(refName) {
    const resolved = await this.ctx.credentials.resolve(credentialRef2(refName));
    if (!resolved) return void 0;
    return parseCredential(resolved.value);
  }
  async startLogin(options = {}) {
    this.active = true;
    const started = await startOfficeAceOAuthFlow({ ...options, fetcher: this.fetchImpl });
    const result = started.result.then((flow) => this.persistLogin(flow, options));
    result.catch(() => {
    });
    return { loginUrl: started.loginUrl, result, close: started.close };
  }
  async login(options = {}) {
    this.active = true;
    const started = await startOfficeAceOAuthFlow({ ...options, fetcher: this.fetchImpl });
    let flow;
    try {
      flow = await started.result;
    } finally {
      await started.close();
    }
    return this.persistLogin(flow, options);
  }
  async persistLogin(flow, options = {}) {
    const refName = options.refName ?? OFFICEACE_CREDENTIAL_REF;
    const ref = credentialRef2(refName);
    let credential = parseCredential(flow.access);
    if (credential !== void 0) {
      try {
        const modelInfo = await fetchOfficeAceModelInfo(credential, this.fetchImpl);
        credential = { ...credential, model_app_key: modelInfo.appKey, model_app_secret: modelInfo.appSecret, model_api_url_base: modelInfo.base };
      } catch (error) {
        this.ctx.logger?.warn?.("[officeace] 取订阅模型信息失败（登录仍成功）：" + String(error));
      }
    }
    const access = credential !== void 0 ? JSON.stringify(credential) : flow.access;
    await this.ctx.credentials.set(ref, access);
    if (options.accountId && options.pool) {
      const expiresAt = credential?.expires_at ? Date.parse(credential.expires_at) : void 0;
      await options.pool.addAccount({
        id: options.accountId,
        provider: OFFICEACE_PROVIDER,
        nickname: options.accountId,
        enabled: true,
        credentialRef: refName,
        createdAt: Date.now(),
        expiresAt: Number.isNaN(expiresAt) ? void 0 : expiresAt,
        refreshable: Boolean(credential?.refresh_token)
      });
    }
    return { access, expires: flow.expires, ref, loginUrl: flow.loginUrl, refreshable: Boolean(credential?.refresh_token) };
  }
  async refreshAccountCredential(refName, pool, accountId) {
    await this.queueFor(refName).run(async () => {
      const ref = credentialRef2(refName);
      const credential = await this.readCredential(refName);
      if (credential === void 0) throw new Error("凭据未配置");
      if (!(credential.refresh_token && credential.code_verifier && credential.dpop_private_key_jwk)) throw new Error("无 refresh_token，请重新登录");
      let refreshed = credential;
      const expiresAt = Date.parse(credential.expires_at ?? "");
      if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < 5 * 60 * 1e3) {
        const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk);
        const token = await officeAceExchangeRefresh(credential.refresh_token, credential.code_verifier, keyPair, this.fetchImpl);
        refreshed = {
          ...credentialFromTokenResponse(token, { codeVerifier: credential.code_verifier, codeChallenge: "" }, keyPair),
          model_app_key: credential.model_app_key,
          model_app_secret: credential.model_app_secret,
          model_api_url_base: credential.model_api_url_base
        };
      }
      try {
        const modelInfo = await fetchOfficeAceModelInfo(refreshed, this.fetchImpl);
        refreshed = { ...refreshed, model_app_key: modelInfo.appKey, model_app_secret: modelInfo.appSecret, model_api_url_base: modelInfo.base };
      } catch {
      }
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
      if (pool && accountId) {
        const exp = refreshed.expires_at ? Date.parse(refreshed.expires_at) : void 0;
        try {
          await pool.updateAccount(accountId, { expiresAt: Number.isNaN(exp) ? void 0 : exp, refreshable: Boolean(refreshed.refresh_token) });
        } catch {
        }
      }
    });
  }
  async refreshModels() {
  }
  stop() {
    this.active = false;
  }
};
