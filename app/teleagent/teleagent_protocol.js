'use strict';

/**
 * ============================================================================
 * TeleAgent（天翼星辰云电脑）纯原生协议层
 * ----------------------------------------------------------------------------
 * 协议链路（纯 Node.js 原生实现，零外部依赖）：
 *   1. 登录（账密模式）：
 *      GET  /teleai-api/upms/public/auth/getRsaPublicKey     获取 RSA 公钥 + keyId
 *      POST /teleai-api/upms/public/captcha/get              获取 blockPuzzle 滑块验证码
 *      POST /teleai-api/upms/public/captcha/check            本地 PNG 解码计算缺口并校验
 *      POST /teleai-api/upms/public/auth/accountNameLogin    AES-128-GCM + RSA-OAEP(SHA-256) 登录
 *      GET  redirectUri（跟随跳转链累积 Cookie）              获取 agent 域 operationToken (JWT)
 *   2. 实例管理与保活（https://agent.teleai.com.cn/teleagent-manager/v1）：
 *      GET  /instance/list        查询实例列表与状态（100/4=运行中, 3=已关机, 5=排队中）
 *      POST /instance/refresh     官方活跃刷新信号
 *      POST /instance/heartbeat   官方活跃心跳上报
 *      POST /instance/connect     换票保活（并返回临时网页直达 connectURL）
 *      POST /instance/start       远程拉起开机
 *      POST /instance/restart     重启云电脑
 *      POST /instance/cancel      取消排队
 *      GET  /service/status       平台服务健康状态
 *   3. 积分与每日签到（https://agent.teleai.com.cn/superCowork/sapi）：
 *      GET  /user/portal/companyStore/userCenter                  积分余额与套餐信息
 *      GET  /user/portal/companyStore/v3/checkDayTask?theme=light 每日任务完成态查询
 *      GET  /user/portal/companyStore/checkTask?type=daily_login  领取每日登录 100 积分
 *
 * 注：本模块严格独立于 ctyun / ydpc / ecloud 实现，不禁用 TLS 证书校验，
 * 所有网络请求均携带主动超时（AbortSignal.timeout）并保留底层错误根因。
 * ============================================================================
 */

const crypto = require('crypto');
const zlib = require('zlib');

const AUTH_API_BASE = 'https://www.teleai.com.cn/teleai-api';
const MGR_API_BASE = 'https://agent.teleai.com.cn/teleagent-manager/v1';
const SAPI_API_BASE = 'https://agent.teleai.com.cn/superCowork/sapi';

const SUPER_CLIENT_ID = 'Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi';
const SUPER_REDIRECT = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?source=4&state=https://agent.teleai.com.cn/teleagent';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0';
const AUTH_REFERER = 'https://www.teleai.com.cn/master-auth';
const AGENT_ORIGIN = 'https://agent.teleai.com.cn';
const AGENT_REFERER = 'https://agent.teleai.com.cn/teleagent';

const INSTANCE_STATUS_MAP = {
  100: { text: '运行中', powerState: 'on' },
  4: { text: '运行中', powerState: 'on' },
  2: { text: '启动中', powerState: 'starting' },
  3: { text: '已关机', powerState: 'off' },
  5: { text: '排队中', powerState: 'queue' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBase64 = (buf) => Buffer.from(buf).toString('base64');

/** 脱敏账号展示（避免完整手机号/用户名落日志） */
function maskAccount(acc) {
  const s = String(acc || '').trim();
  if (!s) return '';
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(7);
  if (s.length > 4) return s.slice(0, 2) + '***' + s.slice(-2);
  return '***';
}

/** 从 JWT 解析过期时间戳（秒），无效时返回 null */
function parseJwtExp(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) : null;
  } catch (e) {
    return null;
  }
}

/** 归一实例电源状态码 */
function normalizeInstanceStatus(statusCode) {
  const num = Number(statusCode);
  if (Number.isFinite(num) && INSTANCE_STATUS_MAP[num]) {
    return { code: num, ...INSTANCE_STATUS_MAP[num] };
  }
  return {
    code: Number.isFinite(num) ? num : null,
    text: statusCode !== undefined && statusCode !== null && statusCode !== '' ? `状态(${statusCode})` : '状态未知',
    powerState: 'unknown',
  };
}

/** 构造包含底层 cause 信息的网络错误 */
function wrapFetchError(url, err, timeoutMs) {
  let host = url;
  try { host = new URL(url).host; } catch (e) { /* 保留原 url */ }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    const wrapped = new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${host}`);
    wrapped.code = 'TELEAGENT_TIMEOUT';
    wrapped.cause = err;
    return wrapped;
  }
  const causeCode = err && err.cause && err.cause.code;
  const detail = causeCode ? `${err.message} (${causeCode})` : (err && err.message) || String(err);
  const wrapped = new Error(`网络错误 [${host}]: ${detail}`);
  wrapped.code = causeCode || 'TELEAGENT_NETWORK_ERROR';
  wrapped.cause = err;
  return wrapped;
}

/** 带主动超时的原生 fetch 封装（保留 TLS 校验与错误根因） */
async function httpRequest(url, { method = 'GET', headers = {}, body, redirect = 'follow', timeoutMs = 20000 } = {}) {
  const reqHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
  let rawBody;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      rawBody = body;
    } else {
      rawBody = JSON.stringify(body);
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }
  }
  try {
    return await fetch(url, {
      method,
      headers: reqHeaders,
      body: rawBody,
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw wrapFetchError(url, e, timeoutMs);
  }
}

/** 读取 fetch Response 的全部 Set-Cookie 头 */
function readSetCookies(headers) {
  if (headers && typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers && typeof headers.get === 'function' ? headers.get('set-cookie') : null;
  return single ? [single] : [];
}

/**
 * 合并 Set-Cookie 到简易 Cookie Jar。
 * 重要：回跳响应会先种一条域级有效 operationToken，紧接着下发 host 级空值删除 Cookie；
 * 绝不能让空值 operationToken 覆盖掉已获取的有效令牌。
 */
function mergeCookies(jar, headers) {
  const target = jar || {};
  for (const cookie of readSetCookies(headers)) {
    const pair = String(cookie).split(';', 1)[0];
    const sep = pair.indexOf('=');
    if (sep > 0) {
      const name = pair.slice(0, sep).trim();
      const value = pair.slice(sep + 1).trim();
      if (name === 'operationToken' && value === '' && target[name]) continue;
      target[name] = value;
    }
  }
  return target;
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** 极简 8-bit 非隔行 RGB/RGBA PNG 解码器（供滑块缺口识别） */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('验证码图片不是有效 PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || width <= 0 || height <= 0) {
    throw new Error(`不支持的 PNG 格式 (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, ch, data: out };
}

/** 识别滑块原图中的白色描边拼图缺口，返回拖拽 x 偏移 */
function solveBlockPuzzleOffset(origPng) {
  const { width, height, ch, data } = decodePng(origPng);
  const isWhite = (x, y) => {
    const i = (y * width + x) * ch;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);
    return mn > 225 && mx - mn < 18;
  };
  const seen = new Uint8Array(width * height);
  let best = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (seen[idx] || !isWhite(x, y)) continue;
      const stack = [[x, y]];
      seen[idx] = 1;
      let n = 0;
      let minX = x;
      let minY = y;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        n++;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (seen[nIdx] || !isWhite(nx, ny)) continue;
            seen[nIdx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (n > 60 && (!best || n > best.n)) {
        best = { n, x: minX, y: minY };
      }
    }
  }
  if (!best) throw new Error('滑块图未识别到缺口');
  return Math.max(0, best.x - 2);
}

function aesEcbBase64(key, plain) {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return toBase64(Buffer.concat([c.update(plain, 'utf8'), c.final()]));
}

async function authPostJson(pathname, body, timeoutMs = 20000) {
  const res = await httpRequest(`${AUTH_API_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      Origin: 'https://www.teleai.com.cn',
      Referer: AUTH_REFERER,
    },
    body,
    timeoutMs,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${pathname} 响应非 JSON (HTTP ${res.status})`);
  }
}

/** 自动识别并通过 blockPuzzle 滑块验证码（最多 6 轮，间隔 2s 防风控） */
async function solveBlockCaptcha({ onLog, maxAttempts = 6 } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(2000);
    const r = await authPostJson('/upms/public/captcha/get', { captchaType: 'blockPuzzle' });
    const d = r && r.repData;
    if (!d || !d.originalImageBase64 || !d.secretKey || !d.token) {
      throw new Error(`滑块验证码获取失败: ${(r && (r.repMsg || r.message)) || '响应字段缺失'}`);
    }
    let x;
    try {
      x = solveBlockPuzzleOffset(Buffer.from(d.originalImageBase64, 'base64'));
    } catch (e) {
      log(`滑块缺口识别失败（第 ${i + 1}/${maxAttempts} 次）：${e.message}，换图重试`, 'warning');
      continue;
    }
    const pointJson = JSON.stringify({ x, y: 5 });
    const check = await authPostJson('/upms/public/captcha/check', {
      captchaType: 'blockPuzzle',
      pointJson: aesEcbBase64(d.secretKey, pointJson),
      token: d.token,
    });
    if (check && check.repCode === '0000') {
      log(`滑块验证已自动通过（x=${x}，第 ${i + 1} 次）`, 'info');
      return {
        captchaVerification: aesEcbBase64(d.secretKey, `${d.token}---${pointJson}`),
      };
    }
    log(`滑块校验未通过（x=${x}，第 ${i + 1}/${maxAttempts} 次），换图重试`, 'warning');
  }
  throw new Error(`滑块验证码连续 ${maxAttempts} 次未通过`);
}

/** 跟随登录回跳链获取 agent 域 operationToken */
async function followRedirectForToken(startUrl, initialCookies = {}, { onLog, maxHops = 10 } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  let current = startUrl;
  const jar = { ...initialCookies };
  for (let hop = 0; hop < maxHops && current; hop++) {
    const res = await httpRequest(current, {
      method: 'GET',
      headers: { Cookie: cookieHeader(jar) },
      redirect: 'manual',
      timeoutMs: 20000,
    });
    mergeCookies(jar, res.headers);
    if (jar.operationToken) {
      log(`回跳链已获取 operationToken（第 ${hop + 1} 跳）`, 'info');
      return jar.operationToken;
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    const html = await res.text();
    const m = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)
      || html.match(/location\.replace\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      current = new URL(m[1], current).toString();
      continue;
    }
    break;
  }
  throw new Error('回跳链未获取到 operationToken');
}

/**
 * 账号密码登录 TeleAgent，换取 agent 域 operationToken (JWT)。
 * @param {string} account 手机号 / 登录名
 * @param {string} password 明文密码
 * @param {object} [opts] { onLog }
 */
async function loginByPassword(account, password, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const loginName = String(account || '').trim().toLowerCase();
  if (!loginName || !password) {
    throw new Error('账号或密码不能为空');
  }

  // 1. 获取 RSA 公钥与 keyId
  const keyHttpRes = await httpRequest(`${AUTH_API_BASE}/upms/public/auth/getRsaPublicKey`, {
    method: 'GET',
    headers: { Origin: 'https://www.teleai.com.cn', Referer: AUTH_REFERER },
    timeoutMs: 20000,
  });
  const keyRes = await keyHttpRes.json().catch(() => null);
  if (!keyRes || keyRes.code !== '10980001' || !keyRes.data?.publicKey || !keyRes.data?.keyId) {
    throw new Error(`获取登录公钥失败: ${(keyRes && keyRes.message) || `HTTP ${keyHttpRes.status}`}`);
  }
  const { publicKey, keyId } = keyRes.data;

  // 2. 自动完成 blockPuzzle 滑块验证码
  const captcha = await solveBlockCaptcha({ onLog: log });

  // 3. AES-128-GCM (AAD) + RSA-OAEP(SHA-256) 封装密码
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const timestamp = Date.now();
  const requestId = crypto.randomUUID();
  const aad = `loginName=${loginName}&keyId=${keyId}&timestamp=${timestamp}&requestId=${requestId}&clientId=${SUPER_CLIENT_ID}`;

  const gcm = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  gcm.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([gcm.update(String(password), 'utf8'), gcm.final()]);
  const authTag = gcm.getAuthTag();

  const pubKeyObj = crypto.createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const encryptedKeyIv = crypto.publicEncrypt(
    { key: pubKeyObj, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.concat([aesKey, iv])
  );

  const loginBody = {
    loginName,
    keyId,
    timestamp,
    requestId,
    redirectUri: SUPER_REDIRECT,
    clientId: SUPER_CLIENT_ID,
    encryptedKeyIv: toBase64(encryptedKeyIv),
    ciphertext: toBase64(ciphertext),
    tag: toBase64(authTag),
    invitationCode: '',
    captchaCheckResult: captcha,
    publicKey,
  };

  const loginRes = await httpRequest(`${AUTH_API_BASE}/upms/public/auth/accountNameLogin`, {
    method: 'POST',
    headers: { Origin: 'https://www.teleai.com.cn', Referer: AUTH_REFERER },
    body: loginBody,
    timeoutMs: 20000,
  });
  const loginJson = await loginRes.json().catch(() => null);
  if (!loginJson || loginJson.code !== '10980001') {
    const msg = (loginJson && loginJson.message) || `登录失败 (HTTP ${loginRes.status})`;
    const code = loginJson && loginJson.code;
    const err = new Error(code ? `${msg} (code=${code})` : msg);
    err.code = code || 'TELEAGENT_LOGIN_FAILED';
    throw err;
  }

  const data = loginJson.data || {};
  log(`账密校验通过 (${maskAccount(loginName)})，正在换取 agent 域凭据…`, 'info');

  // 4. 跟随 superCowork 回跳换取 operationToken
  const redirect = data.redirectUri || SUPER_REDIRECT;
  if (!redirect.includes('agent.teleai.com.cn')) {
    throw new Error(`登录回跳域名异常（非 agent.teleai.com.cn）：${redirect.slice(0, 60)}`);
  }

  const jar = mergeCookies({}, loginRes.headers);
  const cbRes = await httpRequest(redirect, {
    method: 'GET',
    headers: { Cookie: cookieHeader(jar) },
    redirect: 'manual',
    timeoutMs: 20000,
  });
  mergeCookies(jar, cbRes.headers);

  let operationToken = jar.operationToken || '';
  if (!operationToken) {
    const loc = cbRes.headers.get('location');
    if (cbRes.status >= 300 && cbRes.status < 400 && loc) {
      operationToken = await followRedirectForToken(new URL(loc, redirect).toString(), jar, { onLog: log });
    } else {
      throw new Error(`回跳未获取到 operationToken (HTTP ${cbRes.status})`);
    }
  }

  const jwtExp = parseJwtExp(operationToken);
  return {
    operationToken,
    jwtExp,
    expiresAt: data.expiresAt || (jwtExp ? jwtExp * 1000 : 0),
    refreshToken: data.refreshToken || '',
  };
}

/** 调用 teleagent-manager API（实例管理、心跳、换票、开机、重启、服务状态） */
async function mgrRequest(jwt, method, pathname, body = null, timeoutMs = 20000) {
  if (!jwt) {
    const err = new Error('无有效 TeleAgent 会话凭据 (operationToken)');
    err.code = 'TELEAGENT_NO_TOKEN';
    throw err;
  }
  const url = `${MGR_API_BASE}${pathname.startsWith('/') ? pathname : '/' + pathname}`;
  const res = await httpRequest(url, {
    method,
    headers: {
      Cookie: `operationToken=${jwt}`,
      'x-client-platform': 'web',
      Referer: AGENT_REFERER,
      Origin: AGENT_ORIGIN,
    },
    body: body !== null && body !== undefined ? body : undefined,
    timeoutMs,
  });
  if (res.status === 401) {
    const err = new Error('TeleAgent 会话已失效 (401)');
    err.code = 'TELEAGENT_TOKEN_EXPIRED';
    err.statusCode = 401;
    throw err;
  }
  const text = await res.text();
  if (res.status !== 200) {
    const err = new Error(`teleagent-manager ${pathname} 返回 HTTP ${res.status}`);
    err.code = 'TELEAGENT_HTTP_ERROR';
    err.statusCode = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`teleagent-manager ${pathname} 响应非 JSON`);
  }
  if (json && json.error && json.error.code !== 0) {
    const err = new Error(json.error.message || `业务错误 code=${json.error.code}`);
    err.code = String(json.error.code);
    if (String(json.error.code) === '401' || /未登录|token|失效|过期/i.test(err.message)) {
      err.tokenExpired = true;
    }
    throw err;
  }
  return json;
}

/** 调用 superCowork SAPI（积分余额、每日任务状态、领取每日登录积分） */
async function sapiRequest(jwt, pathname, timeoutMs = 15000) {
  if (!jwt) {
    const err = new Error('无有效 TeleAgent 会话凭据 (operationToken)');
    err.code = 'TELEAGENT_NO_TOKEN';
    throw err;
  }
  const url = `${SAPI_API_BASE}${pathname.startsWith('/') ? pathname : '/' + pathname}`;
  const res = await httpRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: AGENT_ORIGIN,
      Referer: AGENT_REFERER,
      Cookie: `operationToken=${jwt}`,
    },
    timeoutMs,
  });
  if (res.status === 401) {
    const err = new Error('TeleAgent 会话已失效 (401)');
    err.code = 'TELEAGENT_TOKEN_EXPIRED';
    err.statusCode = 401;
    throw err;
  }
  const text = await res.text();
  if (res.status !== 200) {
    const err = new Error(`superCowork ${pathname} 返回 HTTP ${res.status}`);
    err.code = 'TELEAGENT_HTTP_ERROR';
    err.statusCode = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`superCowork ${pathname} 响应非 JSON`);
  }
  if (json && (json.code === 401 || json.code === '401')) {
    const err = new Error(json.message || 'TeleAgent 会话已失效 (401)');
    err.code = 'TELEAGENT_TOKEN_EXPIRED';
    err.tokenExpired = true;
    throw err;
  }
  return json;
}

function isTokenExpiredError(err) {
  if (!err) return false;
  if (err.code === 'TELEAGENT_TOKEN_EXPIRED' || err.tokenExpired === true || err.statusCode === 401) return true;
  return /401|会话已失效|登录已过期|token.*expired/i.test(String(err.message || ''));
}

async function listInstances(jwt) {
  const j = await mgrRequest(jwt, 'GET', '/instance/list');
  return Array.isArray(j.data) ? j.data : [];
}

async function connectInstance(jwt, instanceId) {
  const j = await mgrRequest(jwt, 'POST', '/instance/connect', { id: instanceId });
  if (!j.data || !j.data.connectURL) {
    throw new Error('instance/connect 未返回 connectURL');
  }
  return j.data.connectURL;
}

async function sendInstanceHeartbeat(jwt, instanceId) {
  const results = {};
  let anyOk = false;
  for (const ep of ['refresh', 'heartbeat']) {
    try {
      await mgrRequest(jwt, 'POST', `/instance/${ep}`, { id: instanceId });
      results[ep] = 'ok';
      anyOk = true;
    } catch (e) {
      if (isTokenExpiredError(e)) throw e;
      results[ep] = String(e.message || e).slice(0, 80);
    }
  }
  return { ok: anyOk, results };
}

async function startInstance(jwt, instanceId) {
  const j = await mgrRequest(jwt, 'POST', '/instance/start', { id: instanceId });
  return j.data || null;
}

async function restartInstance(jwt, instanceId) {
  const j = await mgrRequest(jwt, 'POST', '/instance/restart', { id: instanceId });
  return j.data || null;
}

async function cancelInstance(jwt, instanceId) {
  const j = await mgrRequest(jwt, 'POST', '/instance/cancel', { id: instanceId });
  return j.data || null;
}

async function getServiceStatus(jwt) {
  const j = await mgrRequest(jwt, 'GET', '/service/status');
  return (j && j.data) || j || null;
}

async function getUserCenter(jwt) {
  const j = await sapiRequest(jwt, '/user/portal/companyStore/userCenter');
  const d = (j && j.data) || {};
  return {
    balance: d.current_points_balance ?? null,
    planName: d.plan_display_name || null,
    raw: d,
  };
}

async function getDayTask(jwt) {
  return sapiRequest(jwt, '/user/portal/companyStore/v3/checkDayTask?theme=light');
}

async function claimDailyLogin(jwt) {
  return sapiRequest(jwt, '/user/portal/companyStore/checkTask?type=daily_login');
}

/** 从 checkDayTask 响应中抽取每日登录签到任务条目 */
function findDailyLoginTask(dayTaskResp) {
  const list = (dayTaskResp && dayTaskResp.data && Array.isArray(dayTaskResp.data.activity_data))
    ? dayTaskResp.data.activity_data
    : [];
  const task = list.find((a) => String(a && a.jump_url || '').includes('checkTask')) || null;
  if (!task) return { found: false, completed: false, task: null };
  return {
    found: true,
    completed: task.action_status === 'completed',
    points: Number(task.points || task.reward_points || 100) || 100,
    title: task.title || task.name || '每日登录积分',
    status: task.action_status || '',
    task,
  };
}

// ---------------------------------------------------------------------------
// 天翼星辰（TeleAgent）官方扫码登录协议（基于中国电信天翼账号 open.e.189.cn OAuth2）
// 流程：
//   1. GET  /teleai-api/upms/public/auth/getOpenLoginUrl?openType=TYID&type=1
//   2. GET  open.e.189.cn 统一登录页 -> 解析 appId / lt / reqId
//   3. POST https://open.e.189.cn/api/logbox/oauth2/appConf.do -> appKey / returnUrl / paramId / state
//   4. POST https://open.e.189.cn/api/logbox/oauth2/getUUID.do -> uuid / encryuuid / encodeuuid
//   5. GET  https://open.e.189.cn/api/logbox/oauth2/image.do -> 官方二维码图片（转 Base64）
//   6. POST https://open.e.189.cn/api/logbox/oauth2/qrcodeLoginState.do 轮询状态：
//      -106 等待扫码 / -11002 已扫码待确认 / -11001|-20099 过期 / 0 已授权(返回 redirectUrl)
//   7. 解析 redirectUrl (appId/paras/sign) -> openLoginCallbackV2 -> userAccountList
//      -> chooseUserAccountLogin -> followRedirectForToken -> 换取 agent 域 operationToken (JWT)
// ---------------------------------------------------------------------------
const E189_OAUTH_BASE = 'https://open.e.189.cn/api/logbox/oauth2';

function formatE189Date() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${Math.floor(Math.random() * 24)}`;
}

/** 创建一次官方扫码登录会话，返回二维码 Base64 图与后端轮询上下文 */
async function createQrLoginSession() {
  const transferUrl = `https://www.teleai.com.cn/transfer?redirect_uri=${encodeURIComponent(SUPER_REDIRECT)}&client_id=${SUPER_CLIENT_ID}`;
  const openUrlEndpoint = `${AUTH_API_BASE}/upms/public/auth/getOpenLoginUrl?openType=TYID&type=1&clientId=${SUPER_CLIENT_ID}&redirectUri=${encodeURIComponent(transferUrl)}`;

  const r1 = await httpRequest(openUrlEndpoint, {
    method: 'GET',
    headers: { Referer: AUTH_REFERER, Origin: 'https://www.teleai.com.cn' },
    timeoutMs: 20000,
  });
  const j1 = await r1.json().catch(() => null);
  const openLoginUrl = (j1 && j1.code === '10980001' && typeof j1.data === 'string') ? j1.data : '';
  if (!openLoginUrl) {
    throw new Error(`获取天翼统一登录入口失败: ${(j1 && j1.message) || `HTTP ${r1.status}`}`);
  }

  const r2 = await httpRequest(openLoginUrl, {
    method: 'GET',
    redirect: 'follow',
    timeoutMs: 20000,
  });
  const finalUrl = new URL(r2.url);
  const appId = finalUrl.searchParams.get('appId') || '';
  const lt = finalUrl.searchParams.get('lt') || '';
  const reqId = finalUrl.searchParams.get('reqId') || '';
  if (!appId || !lt || !reqId) {
    throw new Error('天翼统一登录页缺少必要参数 (appId/lt/reqId)');
  }

  const confRes = await httpRequest(`${E189_OAUTH_BASE}/appConf.do`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      lt,
      reqId,
      Referer: r2.url,
    },
    body: new URLSearchParams({ version: '2.0', appKey: appId }).toString(),
    timeoutMs: 20000,
  });
  const conf = await confRes.json().catch(() => null);
  if (!conf || String(conf.result) !== '0' || !conf.data?.appKey) {
    throw new Error(`获取扫码配置失败: ${(conf && conf.msg) || `HTTP ${confRes.status}`}`);
  }

  const uuidRes = await httpRequest(`${E189_OAUTH_BASE}/getUUID.do`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      lt,
      reqId,
      Referer: r2.url,
    },
    body: new URLSearchParams({ appId: conf.data.appKey }).toString(),
    timeoutMs: 20000,
  });
  const uuidJson = await uuidRes.json().catch(() => null);
  if (!uuidJson || Number(uuidJson.result) !== 0 || !uuidJson.uuid || !uuidJson.encryuuid || !uuidJson.encodeuuid) {
    throw new Error(`生成扫码 UUID 失败: ${(uuidJson && uuidJson.msg) || `HTTP ${uuidRes.status}`}`);
  }

  const imgRes = await httpRequest(`${E189_OAUTH_BASE}/image.do?uuid=${encodeURIComponent(uuidJson.encodeuuid)}&REQID=${encodeURIComponent(reqId)}`, {
    method: 'GET',
    headers: { Referer: r2.url },
    timeoutMs: 20000,
  });
  if (imgRes.status !== 200) {
    throw new Error(`获取官方二维码图片失败 (HTTP ${imgRes.status})`);
  }
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const mime = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const qrImage = `data:${mime};base64,${imgBuf.toString('base64')}`;

  return {
    qrImage,
    expiresAt: Date.now() + 240 * 1000,
    ctx: {
      pageUrl: r2.url,
      appKey: conf.data.appKey,
      lt,
      reqId,
      returnUrl: conf.data.returnUrl || '',
      isOauth2: String(conf.data.isOauth2 ?? 'true'),
      state: String(conf.data.state ?? ''),
      paramId: String(conf.data.paramId ?? ''),
      uuid: uuidJson.uuid,
      encryuuid: uuidJson.encryuuid,
      encodeuuid: uuidJson.encodeuuid,
    },
  };
}

/** 扫码授权成功后，沿着 /transfer -> openLoginCallbackV2 -> userAccountList -> chooseUserAccountLogin 换取 JWT */
async function exchangeQrRedirectForToken(redirectUrl, { onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  let cbUrl = new URL(redirectUrl);
  let appId = cbUrl.searchParams.get('appId') || '';
  let paras = cbUrl.searchParams.get('paras') || '';
  let sign = cbUrl.searchParams.get('sign') || '';

  // 若 redirectUrl 指向中转跳链且尚未带 paras/sign，先跟随一次拿到最终 /transfer 参数
  if (!paras || !sign) {
    let cur = redirectUrl;
    for (let hop = 0; hop < 5; hop++) {
      const r = await httpRequest(cur, { method: 'GET', redirect: 'manual', timeoutMs: 20000 });
      const loc = r.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, cur);
      if (next.searchParams.get('paras') && next.searchParams.get('sign')) {
        cbUrl = next;
        appId = next.searchParams.get('appId') || appId;
        paras = next.searchParams.get('paras') || '';
        sign = next.searchParams.get('sign') || '';
        break;
      }
      cur = next.toString();
    }
  }

  if (!appId || !paras || !sign) {
    throw new Error('扫码回调链接缺少 appId / paras / sign 参数');
  }

  const jar = {};
  const cbEndpoint = `${AUTH_API_BASE}/upms/public/auth/openLoginCallbackV2?${new URLSearchParams({
    openType: 'TYID',
    appId,
    paras,
    sign,
    redirectUri: SUPER_REDIRECT,
    clientId: SUPER_CLIENT_ID,
  }).toString()}`;

  const cbRes = await httpRequest(cbEndpoint, {
    method: 'GET',
    headers: { Referer: 'https://www.teleai.com.cn/transfer', Origin: 'https://www.teleai.com.cn' },
    timeoutMs: 20000,
  });
  mergeCookies(jar, cbRes.headers);
  const cbJson = await cbRes.json().catch(() => null);
  if (!cbJson || cbJson.code !== '10980001') {
    throw new Error(`天翼账号回调校验失败: ${(cbJson && (cbJson.msg || cbJson.message)) || `HTTP ${cbRes.status}`}`);
  }

  const listRes = await httpRequest(`${AUTH_API_BASE}/upms/public/auth/userAccountList?subUser=true`, {
    method: 'GET',
    headers: {
      Cookie: cookieHeader(jar),
      Referer: 'https://www.teleai.com.cn/transfer',
      Origin: 'https://www.teleai.com.cn',
    },
    timeoutMs: 20000,
  });
  mergeCookies(jar, listRes.headers);
  const listJson = await listRes.json().catch(() => null);
  const accounts = (listJson && listJson.code === '10980001' && listJson.data && Array.isArray(listJson.data.accounts))
    ? listJson.data.accounts
    : [];
  if (accounts.length === 0 || !accounts[0].accountId) {
    throw new Error(`未查询到关联的天翼星辰账户: ${(listJson && (listJson.msg || listJson.message)) || `HTTP ${listRes.status}`}`);
  }
  const primaryAccount = accounts[0];

  const chooseRes = await httpRequest(`${AUTH_API_BASE}/upms/public/auth/chooseUserAccountLogin`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      Referer: 'https://www.teleai.com.cn/transfer',
      Origin: 'https://www.teleai.com.cn',
    },
    body: {
      masterUid: primaryAccount.accountId,
      redirectUri: SUPER_REDIRECT,
      clientId: SUPER_CLIENT_ID,
      invitationCode: '',
    },
    timeoutMs: 20000,
  });
  mergeCookies(jar, chooseRes.headers);
  const chooseJson = await chooseRes.json().catch(() => null);
  if (!chooseJson || chooseJson.code !== '10980001' || !chooseJson.data?.redirectUri) {
    throw new Error(`选择天翼星辰账户登录失败: ${(chooseJson && (chooseJson.message || chooseJson.msg)) || `HTTP ${chooseRes.status}`}`);
  }

  const operationToken = await followRedirectForToken(chooseJson.data.redirectUri, jar, { onLog: log });
  const jwtExp = parseJwtExp(operationToken);
  return {
    operationToken,
    jwtExp,
    accountId: String(primaryAccount.accountId),
    accountName: String(primaryAccount.accountName || primaryAccount.loginName || primaryAccount.phoneNumber || primaryAccount.accountId),
    phoneNumber: String(primaryAccount.phoneNumber || primaryAccount.loginName || ''),
  };
}

/** 轮询扫码状态；授权通过后自动完成换票返回 operationToken */
async function pollQrLoginSession(ctx, { onLog } = {}) {
  if (!ctx || !ctx.uuid || !ctx.encryuuid) {
    throw new Error('无效的扫码会话上下文');
  }
  const stateRes = await httpRequest(`${E189_OAUTH_BASE}/qrcodeLoginState.do`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      REQID: ctx.reqId,
      lt: ctx.lt,
      Referer: ctx.pageUrl,
    },
    body: new URLSearchParams({
      appId: ctx.appKey,
      encryuuid: ctx.encryuuid,
      date: formatE189Date(),
      uuid: ctx.uuid,
      returnUrl: encodeURIComponent(ctx.returnUrl || ''),
      clientType: '1',
      timeStamp: String(Date.now()),
      cb_SaveName: '1',
      isOauth2: ctx.isOauth2,
      state: ctx.state,
      paramId: ctx.paramId,
    }).toString(),
    timeoutMs: 20000,
  });
  const st = await stateRes.json().catch(() => null);
  if (!st) {
    throw new Error(`扫码状态查询响应非 JSON (HTTP ${stateRes.status})`);
  }

  if (Number(st.result) === -20099 || Number(st.status) === -11001) {
    return { status: 'expired', rawStatus: st.status ?? st.result };
  }
  if (Number(st.status) === -11002) {
    return { status: 'scanned', rawStatus: st.status };
  }
  if (Number(st.status) === 0 && st.redirectUrl) {
    const auth = await exchangeQrRedirectForToken(st.redirectUrl, { onLog });
    return { status: 'authorized', ...auth };
  }
  return { status: 'waiting', rawStatus: st.status ?? st.result };
}

module.exports = {
  AUTH_API_BASE,
  MGR_API_BASE,
  SAPI_API_BASE,
  INSTANCE_STATUS_MAP,
  maskAccount,
  parseJwtExp,
  normalizeInstanceStatus,
  readSetCookies,
  mergeCookies,
  cookieHeader,
  decodePng,
  solveBlockPuzzleOffset,
  aesEcbBase64,
  solveBlockCaptcha,
  followRedirectForToken,
  loginByPassword,
  createQrLoginSession,
  exchangeQrRedirectForToken,
  pollQrLoginSession,
  mgrRequest,
  sapiRequest,
  isTokenExpiredError,
  listInstances,
  connectInstance,
  sendInstanceHeartbeat,
  startInstance,
  restartInstance,
  cancelInstance,
  getServiceStatus,
  getUserCenter,
  getDayTask,
  claimDailyLogin,
  findDailyLoginTask,
};
