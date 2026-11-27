'use strict';

/**
 * ============================================================================
 * TeleAgent（天翼星辰云 Windows）多账号保活与每日签到客户端
 * ----------------------------------------------------------------------------
 * 平台隔离边界：
 *   - 仅依赖本地 ./teleagent_protocol，严禁复用 ctyun / ydpc / ecloud 或反向依赖 server.js。
 *   - 日志源固定为 LOG_SOURCE = 'TELEAGENT'，平台标签固定为 platform: 'teleagent'。
 *   - 开关判定一律经由宿主注入的 resolveTaskEnabled 统一入口。
 *
 * 登录模式兼容：
 *   - authMode = 'password'：支持账密登录、JWT 持久化恢复、到期前静默续期与 401 自动重登。
 *   - authMode = 'qrcode'  ：预留扫码登录扩展位（后续单独实现），统一通过 applyJwt() 接管会话；
 *                             若无保存密码且 token 失效则标记 sessionExpired 并通知提醒重新扫码。
 * ============================================================================
 */

const defaultProto = require('./teleagent_protocol');

const LOG_SOURCE = 'TELEAGENT';
// 5 秒高精度滴答：配合本地到期预检（未到点零网络请求），让 1 分钟 / 3 分钟精细间隔误差 <= 5s
const WORKER_TICK_MS = 5 * 1000;
const MIN_KEEPALIVE_SEC = 60;
const DEFAULT_KEEPALIVE_SEC = 300;
const DEFAULT_RELOGIN_DAYS = 7;
const RELOGIN_COOLDOWN_MS = 10 * 60 * 1000;
const FORCE_RELOGIN_WINDOW_MS = 15 * 60 * 1000;
const FORCE_RELOGIN_BACKOFF_STEPS_MS = [60 * 1000, 3 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
const AUTOBOOT_COOLDOWN_MS = 10 * 60 * 1000;
const POINTS_POLL_MS = 10 * 60 * 1000;
const SERVICE_POLL_MS = 10 * 60 * 1000;
const STARTING_SYNC_MS = 30 * 1000;
const EMPTY_LIST_RETRY_MS = 60 * 1000;
const RESTART_GUARD_MS = 3 * 60 * 1000;
const LOGIN_SLOT_GAP_MS = Math.max(0, parseInt(process.env.TELEAGENT_LOGIN_GAP_MS, 10) || 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 进程级滑块登录错峰队列：多 TeleAgent 账号并发启动/重登时温和错峰，避免同 IP 滑块风控；
// 保活心跳、换票、实例刷新与每日签到完全不走此队列，保持多账号 100% 并行独立。
let _loginSlotTail = Promise.resolve();
let _lastLoginSlotAt = 0;

function enqueueLoginSlot(taskFn) {
  const run = async () => {
    const waitMs = Math.max(0, _lastLoginSlotAt + LOGIN_SLOT_GAP_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    _lastLoginSlotAt = Date.now();
    return taskFn();
  };
  const next = _loginSlotTail.then(run, run);
  _loginSlotTail = next.catch(() => {});
  return next;
}

function getBeijingTimeString() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingDateStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function buildTeleagentDefaultFeatures() {
  return {
    keepAlive: true,
    autoBoot: true,
    autoSign: true,
    autoRelogin: true,
  };
}

class TeleagentClient {
  /**
   * @param {object} account 账号配置对象（platform: 'teleagent'）
   * @param {object} deps { appendLog, sendNotification, saveConfig, resolveTaskEnabled }
   */
  constructor(account, deps = {}) {
    this.account = account;
    this.proto = deps.proto || defaultProto;
    this.appendLog = deps.appendLog || (() => {});
    this.sendNotification = deps.sendNotification || (() => {});
    this.saveConfig = deps.saveConfig || (() => {});
    this._resolveTaskEnabled = typeof deps.resolveTaskEnabled === 'function'
      ? deps.resolveTaskEnabled
      : null;

    this.jwt = account.savedJwt || '';
    this.jwtExp = account.jwtExp || this.proto.parseJwtExp(this.jwt);

    this.workerRunning = false;
    this._workerTimer = null;
    this._refreshPromise = null;
    this._lastListSyncAt = 0;
    this._instanceLocks = new Map();    // instanceId -> Promise（实例级防重入锁，多机并行互不阻塞）
    this._reloginLock = null;
    this._lastReloginAt = 0;
    this._forceReloginHistory = [];     // 15 分钟内 401 强制重登时间戳（防与外部并存任务互踢死循环）
    this._lastPointsPollAt = 0;
    this._lastServicePollAt = 0;
    this._autoBootCooldown = new Map(); // instanceId -> timestamp
    this._restartingUntil = new Map();  // instanceId -> timestamp

    this.lastSuccessDate = account.stats?.lastSuccessDate || getBeijingDateStr();

    this.metrics = {
      status: this.jwt ? 'online' : 'offline',
      successCount: account.stats?.todaySuccessCount || 0,
      cycles: 0,
      heartbeats: 0,
      healCount: 0,
      keepAliveSeconds: Math.max(MIN_KEEPALIVE_SEC, parseInt(account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC),
      cycleCountdown: Math.max(MIN_KEEPALIVE_SEC, parseInt(account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC),
      lastHeartbeatTime: account.stats?.lastKeepAliveTime || '',
      lastCheckTime: '',
      lastError: account.stats?.lastError || '',
      points: account.stats?.points ?? null,
      planName: account.stats?.planName || '',
      signedToday: !!(account.stats?.lastSignTime && account.stats.lastSignTime.startsWith(getBeijingDateStr())),
      lastSignTime: account.stats?.lastSignTime || '',
      jwtExp: this.jwtExp || null,
      jwtDaysLeft: this._calcJwtDaysLeft(),
      serviceStatus: null,
      desktops: Array.isArray(account.desktops) ? account.desktops : [],
      officialTasks: [],
    };
  }

  _log(message, level = 'info') {
    const accName = this.account.name || this.account.user || 'TeleAgent';
    this.appendLog(LOG_SOURCE, `[${accName}] ${message}`, level, accName, 'teleagent');
  }

  _calcJwtDaysLeft() {
    if (!this.jwtExp) return null;
    const days = (this.jwtExp * 1000 - Date.now()) / 86400000;
    return Number(Math.max(0, days).toFixed(1));
  }

  _syncJwtMetrics() {
    this.metrics.jwtExp = this.jwtExp || null;
    this.metrics.jwtDaysLeft = this._calcJwtDaysLeft();
  }

  /** 统一开关判定入口（委托宿主 resolveTaskEnabled） */
  resolveTask(taskType, desktop = null) {
    if (this._resolveTaskEnabled) {
      return this._resolveTaskEnabled(this.account, desktop, taskType);
    }
    if (this.account.enabled === false) return { enabled: false, reason: '账号已停用' };
    const f = this.account.features || {};
    const key = taskType === 'sign' ? 'autoSign' : taskType;
    if (taskType === 'keepAlive') {
      if (f.keepAlive === false) return { enabled: false, reason: '账号级【常态保活】开关已关闭' };
      if (desktop && desktop.keepaliveEnabled === false) return { enabled: false, reason: '该云电脑的【独立保活】开关已关闭' };
      return { enabled: true, reason: '' };
    }
    if (f[key] === false) return { enabled: false, reason: `账号级开关 (${key}) 已关闭` };
    if (desktop && desktop.taskEnabled === false) return { enabled: false, reason: '单机任务开关已关闭' };
    return { enabled: true, reason: '' };
  }

  /** 注入并持久化 JWT（供账密登录与后续扫码登录共用） */
  applyJwt(jwt, source = 'password') {
    if (!jwt || typeof jwt !== 'string') {
      throw new Error('无效的 TeleAgent JWT 凭据');
    }
    this.jwt = jwt.trim();
    this.jwtExp = this.proto.parseJwtExp(this.jwt);
    this.account.savedJwt = this.jwt;
    this.account.jwtExp = this.jwtExp;
    this.account.sessionExpired = false;
    this.account.stats = this.account.stats || {};
    this.account.stats.lastError = '';
    this.metrics.lastError = '';
    this.metrics.status = 'online';
    this._syncJwtMetrics();
    this.saveConfig();
    const expStr = this.jwtExp ? new Date(this.jwtExp * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '未知';
    this._log(`会话凭据已就绪（来源: ${source}，有效期至 ${expStr}）`, 'success');
    return { ok: true, jwtExp: this.jwtExp, jwtDaysLeft: this.metrics.jwtDaysLeft };
  }

  /** 账密登录并保存凭据（经由进程级登录错峰队列，多账号并发登录不互相踩风控） */
  async loginByPassword(overrideAccount, overridePassword) {
    const user = String(overrideAccount || this.account.user || '').trim();
    const pwd = String(overridePassword || this.account.password || '');
    if (!user || !pwd) {
      throw new Error('TeleAgent 账密登录需要提供手机号/账号与密码');
    }
    const res = await enqueueLoginSlot(() => this.proto.loginByPassword(user, pwd, {
      onLog: (msg, lvl) => this._log(msg, lvl),
    }));
    this.applyJwt(res.operationToken, 'password-login');
    return res;
  }

  /** 计算 401 强制重登的梯度冷却窗口（防与外部并存 TeleAgent 任务互相顶号死循环） */
  getForceReloginCooldownMs(now = Date.now()) {
    this._forceReloginHistory = this._forceReloginHistory.filter((ts) => now - ts < FORCE_RELOGIN_WINDOW_MS);
    const idx = Math.min(this._forceReloginHistory.length, FORCE_RELOGIN_BACKOFF_STEPS_MS.length - 1);
    return FORCE_RELOGIN_BACKOFF_STEPS_MS[idx];
  }

  /**
   * 预留：扫码登录凭据接管入口（扫码交互流程将在兼容完成后单独实现）
   */
  applyQrLoginToken(operationToken) {
    this.account.authMode = 'qrcode';
    return this.applyJwt(operationToken, 'qrcode-login');
  }

  /**
   * 确保当前存在可用且未临近过期的 JWT。
   * - force=true：在 401 场景强制尝试使用已保存密码重登（受冷却期约束，防风控）
   * - force=false：缺失 JWT 或剩余有效期不足 reloginDays 时自动续期
   */
  async ensureToken({ force = false, quiet = false } = {}) {
    if (this._reloginLock) return this._reloginLock;

    const now = Date.now();
    const reloginDays = Math.max(1, parseInt(this.account.reloginDays, 10) || DEFAULT_RELOGIN_DAYS);
    const daysLeft = this.jwtExp ? (this.jwtExp * 1000 - now) / 86400000 : null;
    const isNearExpiry = daysLeft !== null && daysLeft <= reloginDays;
    const isExpired = daysLeft !== null && daysLeft <= 0;

    if (!force && this.jwt && !isExpired && !(isNearExpiry && this.account.features?.autoRelogin !== false && this.account.password)) {
      return this.jwt;
    }

    // 无法自动重登（无密码，例如扫码登录模式）
    if (!this.account.password) {
      if (this.jwt && !force && !isExpired) return this.jwt;
      this.account.sessionExpired = true;
      this.metrics.status = 'offline';
      const msg = 'TeleAgent 会话凭据已失效且未保存密码，请重新扫码或使用账密重新登录';
      this.metrics.lastError = msg;
      this.account.stats = this.account.stats || {};
      this.account.stats.lastError = msg;
      this.account.stats.keepAliveStatus = 'offline';
      this.saveConfig();
      const err = new Error(msg);
      err.code = 'TELEAGENT_RELOGIN_NEEDED';
      throw err;
    }

    // 重登冷却期保护（仅在已有过失败或刚重登不久时限流，首次无 jwt 时不受阻）
    if (this._lastReloginAt > 0 && now - this._lastReloginAt < RELOGIN_COOLDOWN_MS && this.jwt && !isExpired && !force) {
      return this.jwt;
    }
    if (force && this._lastReloginAt > 0) {
      const cooldownMs = this.getForceReloginCooldownMs(now);
      if (now - this._lastReloginAt < cooldownMs) {
        const remainSec = Math.ceil((cooldownMs - (now - this._lastReloginAt)) / 1000);
        const multiHint = this._forceReloginHistory.length >= 2
          ? '（15 分钟内多次 401，请检查是否有其他并存 TeleAgent 任务共用同一账号导致互踢）'
          : '';
        const err = new Error(`401 重登冷却退避中，剩余 ${remainSec} 秒${multiHint}`);
        err.code = 'TELEAGENT_RELOGIN_COOLDOWN';
        throw err;
      }
    }

    this._reloginLock = (async () => {
      const reloginStartedAt = Date.now();
      this._lastReloginAt = reloginStartedAt;
      if (force) {
        this._forceReloginHistory = this._forceReloginHistory.filter((ts) => reloginStartedAt - ts < FORCE_RELOGIN_WINDOW_MS);
        this._forceReloginHistory.push(reloginStartedAt);
      }
      try {
        if (!quiet) {
          this._log(force ? '检测到会话失效(401)，正在使用保存的账密自动重登…' : '会话凭据待初始化或临近过期，正在自动续期登录…', 'info');
        }
        await this.loginByPassword();
        return this.jwt;
      } catch (e) {
        this.metrics.lastError = e.message;
        this.account.stats = this.account.stats || {};
        this.account.stats.lastError = e.message;
        if (force || !this.jwt || isExpired) {
          this.account.sessionExpired = true;
          this.metrics.status = 'offline';
          this.account.stats.keepAliveStatus = 'offline';
        }
        this.saveConfig();
        this._log(`自动登录/续期失败: ${e.message}`, 'error');
        throw e;
      } finally {
        this._reloginLock = null;
      }
    })();

    return this._reloginLock;
  }

  /** 带 401 自动重登重试的统一请求包装 */
  async _withTokenRetry(fn) {
    await this.ensureToken({ force: false, quiet: true });
    try {
      return await fn(this.jwt);
    } catch (e) {
      if (this.proto.isTokenExpiredError(e)) {
        await this.ensureToken({ force: true, quiet: false });
        return await fn(this.jwt);
      }
      throw e;
    }
  }

  /** 刷新账号名下云 Windows 实例列表（并发去重 + 按 instanceId 差量合并，保留单机独立开关、周期与计数） */
  async refreshInstances() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const rawList = await this._withTokenRetry((jwt) => this.proto.listInstances(jwt));
      const prevList = Array.isArray(this.account.desktops) ? this.account.desktops : [];
      const prevMap = new Map(prevList.map((d) => [String(d.instanceId || d.id), d]));

      const merged = rawList.map((item, idx) => {
        const iid = String(item.id || item.instanceId || `ta_${idx}`);
        const prev = prevMap.get(iid) || {};
        const st = this.proto.normalizeInstanceStatus(item.status);
        const prevStatusCode = prev.instanceStatus;
        const dName = item.name || item.instanceName || prev.desktopName || `星辰云电脑_${iid.slice(-4)}`;
        if (prevStatusCode !== undefined && prevStatusCode !== st.code) {
          this._log(`实例 [${dName}] 平台状态变化：${prev.statusText || prevStatusCode} -> ${st.text} (status=${st.code})`, st.powerState === 'on' ? 'info' : 'warning');
        }
        return {
          ...prev,
          instanceId: iid,
          id: iid,
          desktopName: dName,
          instanceStatus: st.code,
          statusText: st.text,
          powerState: st.powerState,
          specStr: item.spec || item.specification || item.config || prev.specStr || '',
          expireTime: item.expireTime || item.expiredAt || item.expire_time || prev.expireTime || '',
          region: item.region || item.zone || prev.region || '',
          rawInfo: item,
          keepaliveEnabled: prev.keepaliveEnabled !== false,
          autoBootEnabled: prev.autoBootEnabled !== false,
          keepaliveInterval: prev.keepaliveInterval || null,
          lastKeepAliveAt: prev.lastKeepAliveAt || 0,
          _cycles: prev._cycles || 0,
          _heartbeats: prev._heartbeats || 0,
          _healCount: prev._healCount || 0,
        };
      });

      this._lastListSyncAt = Date.now();
      this.account.desktops = merged;
      this.metrics.desktops = merged;
      this.metrics.lastCheckTime = getBeijingTimeString();
      this._syncJwtMetrics();
      this.saveConfig();
      return merged;
    })().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  /** 刷新积分余额、套餐名称与今日签到任务状态 */
  async refreshPointsAndTasks() {
    const out = { ok: false, balance: this.metrics.points, planName: this.metrics.planName, signedToday: this.metrics.signedToday };
    try {
      const uc = await this._withTokenRetry((jwt) => this.proto.getUserCenter(jwt));
      if (uc.balance !== null && uc.balance !== undefined) {
        this.metrics.points = uc.balance;
        this.account.stats = this.account.stats || {};
        this.account.stats.points = uc.balance;
      }
      if (uc.planName) {
        this.metrics.planName = uc.planName;
        this.account.stats = this.account.stats || {};
        this.account.stats.planName = uc.planName;
      }
      out.balance = this.metrics.points;
      out.planName = this.metrics.planName;

      const dayTaskResp = await this._withTokenRetry((jwt) => this.proto.getDayTask(jwt)).catch(() => null);
      if (dayTaskResp) {
        const dt = this.proto.findDailyLoginTask(dayTaskResp);
        if (dt.found) {
          this.metrics.signedToday = dt.completed;
          this.metrics.officialTasks = [{
            name: dt.title || '每日登录积分',
            points: dt.points || 100,
            status: dt.completed ? 2 : 0,
            current: dt.completed ? 1 : 0,
            total: 1,
          }];
          if (dt.completed) {
            const today = getBeijingDateStr();
            this.account.stats = this.account.stats || {};
            if (!this.account.stats.lastSignTime || !this.account.stats.lastSignTime.startsWith(today)) {
              this.account.stats.lastSignTime = getBeijingTimeString();
            }
            this.metrics.lastSignTime = this.account.stats.lastSignTime;
          }
          out.signedToday = dt.completed;
        }
      }
      this._lastPointsPollAt = Date.now();
      this.saveConfig();
      out.ok = true;
      return out;
    } catch (e) {
      out.error = e.message;
      this._log(`积分与每日任务状态刷新失败: ${e.message}`, 'warning');
      return out;
    }
  }

  /**
   * 执行 TeleAgent 每日登录积分签到（以官方 checkDayTask 复核为准，绝不虚报）
   * @returns {{ ok: boolean, isCompleted: boolean, status: string, balance: number|null, message: string }}
   */
  async runDailySign({ trigger = 'manual' } = {}) {
    this._log(`开始执行每日登录积分签到（触发来源: ${trigger}）…`, 'info');
    try {
      // 1. 前置幂等查询：官方确认已完成则直接返回
      let preTask = null;
      try {
        const dt = await this._withTokenRetry((jwt) => this.proto.getDayTask(jwt));
        preTask = this.proto.findDailyLoginTask(dt);
        if (preTask.found && preTask.completed) {
          await this.refreshPointsAndTasks();
          this._log(`今日登录积分已完成领取（余额 ${this.metrics.points ?? '未知'}）`, 'info');
          return {
            ok: true,
            isCompleted: true,
            status: 'already_claimed',
            balance: this.metrics.points,
            message: `今日已完成签到领取，当前积分余额 ${this.metrics.points ?? '未知'}`,
          };
        }
      } catch (e) {
        this._log(`前置查询每日任务状态失败（${e.message}），继续尝试领取…`, 'warning');
      }

      // 2. 调用领取接口
      const claimResp = await this._withTokenRetry((jwt) => this.proto.claimDailyLogin(jwt));
      const claimAccepted = !!(claimResp && (claimResp.code === 200 || claimResp.code === 0));

      // 3. 官方复核（checkDayTask + userCenter）
      const post = await this.refreshPointsAndTasks();
      const confirmed = post.signedToday === true;

      if (claimAccepted || confirmed) {
        const nowStr = getBeijingTimeString();
        this.account.stats = this.account.stats || {};
        this.account.stats.lastSignTime = nowStr;
        this.metrics.lastSignTime = nowStr;
        this.metrics.signedToday = true;
        this.saveConfig();
        const status = claimAccepted ? 'claimed' : 'already_claimed';
        const msg = status === 'claimed'
          ? `每日登录积分签到成功（+100 积分），当前余额 ${this.metrics.points ?? '未知'}`
          : `官方已确认今日签到已完成，当前余额 ${this.metrics.points ?? '未知'}`;
        this._log(`🎉 ${msg}`, 'success');
        if (status === 'claimed') {
          this.sendNotification(
            this.account,
            `🎁 TeleAgent 每日积分签到成功 - ${this.account.name}`,
            `账号【${this.account.name}】今日每日登录积分已领取成功！\n当前积分余额：${this.metrics.points ?? '未知'}`
          );
        }
        return { ok: true, isCompleted: true, status, balance: this.metrics.points, message: msg };
      }

      const rawSummary = JSON.stringify(claimResp || {}).slice(0, 140);
      const errMsg = `签到接口未返回成功且官方复核未完成: ${rawSummary}`;
      this._log(errMsg, 'warning');
      return { ok: false, isCompleted: false, status: 'unconfirmed', balance: this.metrics.points, message: errMsg };
    } catch (e) {
      this._log(`每日签到执行异常: ${e.message}`, 'error');
      return { ok: false, isCompleted: false, status: 'error', balance: this.metrics.points, message: e.message };
    }
  }

  /** 检查实例是否启用了自动开机守护（账号级 + 单机双开关，默认开启） */
  _isAutoBootArmed(desktop) {
    if (this.account.features?.autoBoot === false) return false;
    if (desktop && desktop.autoBootEnabled === false) return false;
    return true;
  }

  /** 轮询实例直到运行中（100 或 4） */
  async _waitInstanceReady(instanceId, maxMs = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const list = await this.refreshInstances();
        const target = list.find((d) => String(d.instanceId) === String(instanceId));
        if (target && target.powerState === 'on') return true;
      } catch (e) {
        this._log(`等待实例就绪轮询异常: ${e.message}`, 'warning');
      }
      await sleep(6000);
    }
    return false;
  }

  /** 单台实例远程自愈拉起（受 10 分钟冷却与重启保护窗约束） */
  async _healInstance(desktop) {
    const iid = String(desktop.instanceId);
    const dName = desktop.desktopName || iid;
    const now = Date.now();

    const guardUntil = this._restartingUntil.get(iid) || 0;
    if (now < guardUntil) {
      this._log(`[${dName}] 处于平台重启保护窗内（状态: ${desktop.statusText}），等待恢复不重复拉起`, 'info');
      return { healed: false, skipped: 'restarting' };
    }

    const lastBoot = this._autoBootCooldown.get(iid) || 0;
    if (now - lastBoot < AUTOBOOT_COOLDOWN_MS) {
      const remainMin = Math.ceil((AUTOBOOT_COOLDOWN_MS - (now - lastBoot)) / 60000);
      this._log(`[${dName}] 实例状态为「${desktop.statusText}」，自动开机冷却中（剩约 ${remainMin} 分钟）`, 'info');
      return { healed: false, skipped: 'cooldown' };
    }

    this._autoBootCooldown.set(iid, now);
    this._log(`[${dName}] 检测到实例状态「${desktop.statusText}」，触发自动开机守护（instance/start）…`, 'warning');
    this.sendNotification(
      this.account,
      `⚠️ TeleAgent 云电脑非运行状态，正在自动拉起 - ${this.account.name}`,
      `实例：${dName} (${iid})\n当前状态：${desktop.statusText}\n已自动下发 instance/start 拉起指令。`
    );

    let ready = false;
    for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
      try {
        await this._withTokenRetry((jwt) => this.proto.startInstance(jwt, iid));
        this._log(`[${dName}] instance/start 第 ${attempt} 次已受理，轮询等待就绪…`, 'info');
      } catch (e) {
        this._log(`[${dName}] instance/start 第 ${attempt} 次调用异常: ${e.message}`, 'warning');
      }
      ready = await this._waitInstanceReady(iid, 60000);
    }

    if (ready) {
      desktop._healCount = (desktop._healCount || 0) + 1;
      this.metrics.healCount++;
      this._log(`[${dName}] 🎉 自动开机守护成功：实例已恢复运行中`, 'success');
      this.sendNotification(
        this.account,
        `✅ TeleAgent 云电脑已自动拉起 - ${this.account.name}`,
        `实例：${dName} (${iid}) 已恢复为运行中状态。`
      );
      return { healed: true };
    }
    this._log(`[${dName}] 自动开机指令已下发，但等待窗口内尚未进入运行中状态（下轮继续观测）`, 'warning');
    return { healed: false, pending: true };
  }

  /** 单台实例执行一次心跳 + 换票保活 */
  async _keepAliveDesktop(desktop) {
    const iid = String(desktop.instanceId);
    const dName = desktop.desktopName || iid;

    // 1. 非运行中状态处理
    if (desktop.powerState === 'starting') {
      this._log(`[${dName}] 实例正在启动中，等待就绪后自动继续保活`, 'info');
      return { ok: false, skipped: true, reason: '实例启动中' };
    }
    if (desktop.powerState !== 'on') {
      if (this._isAutoBootArmed(desktop)) {
        const healRes = await this._healInstance(desktop);
        if (!healRes.healed) {
          return { ok: false, skipped: true, reason: `实例未运行(${desktop.statusText})` };
        }
      } else {
        this._log(`[${dName}] 实例处于「${desktop.statusText}」且未开启自动开机守护，本轮跳过保活`, 'info');
        return { ok: false, skipped: true, reason: `实例未运行(${desktop.statusText})` };
      }
    }

    // 2. 官方活跃心跳（refresh + heartbeat），单个失败不阻断换票
    let hbRes = { ok: false, results: {} };
    try {
      hbRes = await this._withTokenRetry((jwt) => this.proto.sendInstanceHeartbeat(jwt, iid));
      if (hbRes.ok) {
        desktop._heartbeats = (desktop._heartbeats || 0) + 1;
        this.metrics.heartbeats++;
      }
    } catch (e) {
      this._log(`[${dName}] 官方活跃心跳异常（将继续尝试换票）: ${e.message}`, 'warning');
    }

    // 3. instance/connect 换票保活（最多 3 次重试）
    let connectUrl = '';
    let lastErr = '';
    for (let i = 1; i <= 3; i++) {
      try {
        connectUrl = await this._withTokenRetry((jwt) => this.proto.connectInstance(jwt, iid));
        break;
      } catch (e) {
        lastErr = e.message;
        if (i < 3) await sleep(3000);
      }
    }
    if (!connectUrl) {
      throw new Error(`[${dName}] 换票保活失败: ${lastErr || '未返回票据'}`);
    }

    const now = Date.now();
    desktop.lastKeepAliveAt = now;
    desktop.powerState = 'on';
    desktop.instanceStatus = 100;
    desktop.statusText = '运行中';
    desktop._lastError = '';
    desktop._lastHeartbeat = hbRes.results;
    desktop._cycles = (desktop._cycles || 0) + 1;

    const todayStr = getBeijingDateStr();
    if (this.lastSuccessDate !== todayStr) {
      this.metrics.successCount = 0;
      this.lastSuccessDate = todayStr;
    }
    this.metrics.successCount++;
    this.metrics.cycles++;
    this.metrics.lastHeartbeatTime = getBeijingTimeString();
    this.metrics.status = 'online';
    this.metrics.lastError = '';

    this.account.stats = this.account.stats || {};
    this.account.stats.keepAliveStatus = 'online';
    this.account.stats.lastKeepAliveTime = this.metrics.lastHeartbeatTime;
    this.account.stats.todaySuccessCount = this.metrics.successCount;
    this.account.stats.lastSuccessDate = todayStr;
    this.account.stats.lastError = '';
    this.saveConfig();

    const hbSummary = `refresh=${hbRes.results?.refresh || '-'}, heartbeat=${hbRes.results?.heartbeat || '-'}`;
    this._log(`[${dName}] 💓 保活换票与活跃信号完成（第 ${desktop._cycles} 轮，${hbSummary}）`, 'info');
    return { ok: true, instanceId: iid, cycles: desktop._cycles, heartbeat: hbRes.results };
  }

  /**
   * 本地到期预检：5 秒高精度滴答下，若所有已启用实例都未到点且积分/服务轮询未到点，
   * 直接跳过而不发任何 /instance/list 请求，兼顾 1 分钟 / 3 分钟高精度与低风控开销。
   */
  _inspectDueWork(now = Date.now()) {
    const cached = Array.isArray(this.account.desktops) ? this.account.desktops : [];
    const baseIntervalSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(this.account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC);
    const pointsDue = now - this._lastPointsPollAt >= POINTS_POLL_MS;
    const serviceDue = now - this._lastServicePollAt >= SERVICE_POLL_MS;

    if (cached.length === 0) {
      const needList = (now - this._lastListSyncAt) >= EMPTY_LIST_RETRY_MS;
      return { needList, anyDesktopDue: needList, pointsDue, serviceDue };
    }

    let anyDesktopDue = false;
    let needStartingSync = false;
    for (const d of cached) {
      const iid = String(d.instanceId || d.id || '');
      if (this._instanceLocks.has(iid)) continue;
      if (!this.resolveTask('keepAlive', d).enabled) continue;
      if ((d.powerState === 'starting' || d.powerState === 'queue') && (now - this._lastListSyncAt) >= STARTING_SYNC_MS) {
        needStartingSync = true;
      }
      const intervalSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(d.keepaliveInterval, 10) || baseIntervalSec);
      const elapsedMs = d.lastKeepAliveAt ? (now - d.lastKeepAliveAt) : Infinity;
      if (elapsedMs >= intervalSec * 1000) {
        anyDesktopDue = true;
      }
    }

    return {
      needList: anyDesktopDue || needStartingSync,
      anyDesktopDue,
      pointsDue,
      serviceDue,
    };
  }

  /** 实例级防重入锁包装：同账号多台实例可并行保活/自愈，单实例自身防重入 */
  async _runDesktopWithLock(desktop) {
    const iid = String(desktop.instanceId || desktop.id || '');
    if (this._instanceLocks.has(iid)) {
      return { instanceId: iid, desktopName: desktop.desktopName, ok: false, skipped: true, reason: '该实例保活执行中' };
    }
    const p = (async () => {
      try {
        const r = await this._keepAliveDesktop(desktop);
        return { instanceId: iid, desktopName: desktop.desktopName, ...r };
      } catch (e) {
        desktop._lastError = e.message;
        this.metrics.lastError = e.message;
        this.account.stats = this.account.stats || {};
        this.account.stats.lastError = e.message;
        this._log(`[${desktop.desktopName || iid}] 保活异常: ${e.message}`, 'error');
        return { instanceId: iid, desktopName: desktop.desktopName, ok: false, error: e.message };
      } finally {
        this._instanceLocks.delete(iid);
      }
    })();
    this._instanceLocks.set(iid, p);
    return p;
  }

  /** 执行一轮巡检（manual=true 强制全部/指定已启用实例立刻跑一轮；自动巡检按单机独立周期并行触发） */
  async runKeepAliveOnce({ manual = false, instanceId = '' } = {}) {
    try {
      const accGate = this.resolveTask('keepAlive', null);
      if (!manual && !accGate.enabled) {
        this.metrics.status = 'offline';
        return { ok: false, skipped: true, reason: accGate.reason };
      }

      const now = Date.now();
      const baseIntervalSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(this.account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC);
      this.metrics.keepAliveSeconds = baseIntervalSec;

      const due = manual ? { needList: true, anyDesktopDue: true, pointsDue: true, serviceDue: true } : this._inspectDueWork(now);
      if (!manual && !due.needList && !due.pointsDue && !due.serviceDue) {
        return { ok: true, acted: false, skipped: true, reason: '未到保活周期', results: [] };
      }

      let desktops = Array.isArray(this.account.desktops) ? this.account.desktops : [];
      if (manual || due.needList) {
        desktops = await this.refreshInstances();
        if (desktops.length === 0) {
          this._log('账号名下未发现 TeleAgent 云电脑实例', 'warning');
          return { ok: false, message: '名下未发现云电脑实例', results: [] };
        }
      }

      const checkNow = Date.now();
      const targets = [];
      for (const d of desktops) {
        const iid = String(d.instanceId || d.id || '');
        if (instanceId && iid !== String(instanceId)) continue;
        const vmGate = this.resolveTask('keepAlive', d);
        if (!manual && !vmGate.enabled) continue;

        const intervalSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(d.keepaliveInterval, 10) || baseIntervalSec);
        const elapsedMs = d.lastKeepAliveAt ? (checkNow - d.lastKeepAliveAt) : Infinity;
        if (!manual && elapsedMs < intervalSec * 1000) continue;

        targets.push(d);
      }

      // 实例级并行执行：A 机若在拉起自愈等待，不影响 B 机按 1 分钟 / 3 分钟周期准时保活
      const results = targets.length > 0
        ? await Promise.all(targets.map((d) => this._runDesktopWithLock(d)))
        : [];
      const acted = results.some((r) => !r.skipped);

      // 顺带按 10 分钟节流同步积分与服务状态
      if (manual || Date.now() - this._lastPointsPollAt >= POINTS_POLL_MS) {
        await this.refreshPointsAndTasks().catch(() => {});
      }
      if (manual || Date.now() - this._lastServicePollAt >= SERVICE_POLL_MS) {
        this._lastServicePollAt = Date.now();
        try {
          const svc = await this._withTokenRetry((jwt) => this.proto.getServiceStatus(jwt));
          this.metrics.serviceStatus = { ok: true, at: Date.now(), data: svc };
        } catch (e) {
          this.metrics.serviceStatus = { ok: false, at: Date.now(), error: e.message };
        }
      }

      this._syncJwtMetrics();
      return { ok: true, acted, results };
    } catch (e) {
      this.metrics.lastError = e.message;
      this.account.stats = this.account.stats || {};
      this.account.stats.lastError = e.message;
      this._log(`巡检失败: ${e.message}`, 'error');
      throw e;
    }
  }

  /** 启动独立后台看护循环（20s tick，按单机时间戳独立调度） */
  startKeepAliveWorker() {
    if (this.workerRunning) return;
    const gate = this.resolveTask('keepAlive', null);
    if (!gate.enabled) {
      this._log(`未启动保活看护：${gate.reason}`, 'info');
      return;
    }
    this.workerRunning = true;
    const baseSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(this.account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC);
    this.metrics.keepAliveSeconds = baseSec;
    this._log(`已启动 TeleAgent 独立保活看护循环（基准周期 ${baseSec}s）`, 'info');

    // 启动后异步跑首轮
    this.runKeepAliveOnce({ manual: false }).catch((e) => {
      this._log(`首轮保活巡检异常: ${e.message}`, 'warning');
    });

    this._workerTimer = setInterval(() => {
      if (!this.workerRunning) return;
      const g = this.resolveTask('keepAlive', null);
      if (!g.enabled) {
        this.stopKeepAliveWorker();
        return;
      }
      this.runKeepAliveOnce({ manual: false }).catch((e) => {
        this._log(`定时巡检异常: ${e.message}`, 'warning');
      });
    }, WORKER_TICK_MS);
    if (this._workerTimer.unref) this._workerTimer.unref();
  }

  stopKeepAliveWorker() {
    if (this._workerTimer) {
      clearInterval(this._workerTimer);
      this._workerTimer = null;
    }
    if (this.workerRunning) {
      this.workerRunning = false;
      this.metrics.status = 'offline';
      this._log('已停止 TeleAgent 保活看护循环', 'info');
    }
  }

  /** 电源管理（开机 / 重启 / 取消排队；平台不支持远程关机时如实告知） */
  async powerDesktop(instanceId, action = 'poweron') {
    const iid = String(instanceId || this.account.desktops?.[0]?.instanceId || '');
    if (!iid) {
      throw new Error('未指定目标云电脑实例 ID，请先刷新实例列表');
    }
    const act = String(action || '').toLowerCase();
    if (act === 'poweron' || act === 'boot' || act === 'start' || act === 'available') {
      const data = await this._withTokenRetry((jwt) => this.proto.startInstance(jwt, iid));
      this._log(`实例 [${iid}] 开机指令 (instance/start) 平台已受理（受理 ≠ 已开机，以状态刷新为准）`, 'info');
      return { success: true, accepted: true, action: 'poweron', message: '平台已受理开机指令（受理 ≠ 已开机，请稍后刷新查看状态）', data };
    }
    if (act === 'reboot' || act === 'restart') {
      const data = await this._withTokenRetry((jwt) => this.proto.restartInstance(jwt, iid));
      this._restartingUntil.set(iid, Date.now() + RESTART_GUARD_MS);
      this._log(`实例 [${iid}] 重启指令 (instance/restart) 平台已受理（约 1 分钟恢复，已进入 3 分钟保护窗）`, 'warning');
      return { success: true, accepted: true, action: 'reboot', message: '平台已受理重启指令（预计 1 分钟后恢复，不重装不影响数据）', data };
    }
    if (act === 'cancel') {
      const data = await this._withTokenRetry((jwt) => this.proto.cancelInstance(jwt, iid));
      this._log(`实例 [${iid}] 取消排队指令 (instance/cancel) 平台已受理`, 'info');
      return { success: true, accepted: true, action: 'cancel', message: '平台已受理取消排队指令', data };
    }
    if (act === 'shutdown' || act === 'poweroff') {
      return { success: false, error: 'TeleAgent 平台官方接口未提供远程关机指令，仅支持开机与重启' };
    }
    return { success: false, error: `不支持的电源操作: ${act}` };
  }

  /** 获取一键直达网页云电脑临时票据 URL */
  async getFreshConnectUrl(instanceId) {
    let iid = String(instanceId || this.account.desktops?.[0]?.instanceId || '');
    if (!iid) {
      const list = await this.refreshInstances();
      iid = String(list[0]?.instanceId || '');
    }
    if (!iid) throw new Error('未找到可用 TeleAgent 实例');
    const url = await this._withTokenRetry((jwt) => this.proto.connectInstance(jwt, iid));
    return { success: true, instanceId: iid, connectUrl: url };
  }

  /** 序列化时现算单机保活状态视图（供前端卡片渲染） */
  describeDesktopKeepAlive(desktop) {
    const now = Date.now();
    const baseSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(this.account.keepaliveInterval, 10) || DEFAULT_KEEPALIVE_SEC);
    const intervalSec = Math.max(MIN_KEEPALIVE_SEC, parseInt(desktop.keepaliveInterval, 10) || baseSec);
    const lastAt = desktop.lastKeepAliveAt || 0;
    const elapsedSec = lastAt > 0 ? Math.max(0, Math.floor((now - lastAt) / 1000)) : null;
    const remainSec = lastAt > 0 ? Math.max(0, intervalSec - elapsedSec) : 0;

    const accGate = this.resolveTask('keepAlive', null);
    const vmGate = this.resolveTask('keepAlive', desktop);
    const powerState = desktop.powerState || 'unknown';
    const running = powerState === 'on';

    let tone = 'idle';
    let actionText = '等待首轮巡检';

    const desktopCycles = desktop._cycles || this.metrics.cycles;
    const isBusy = this._instanceLocks.has(String(desktop.instanceId || desktop.id || ''));

    if (this.account.sessionExpired) {
      tone = 'error';
      actionText = '会话已失效，待重新登录';
    } else if (!accGate.enabled) {
      tone = 'off';
      actionText = '账号保活总开关已关闭';
    } else if (!vmGate.enabled) {
      tone = 'off';
      actionText = '单机保活已关闭';
    } else if (isBusy) {
      tone = 'idle';
      actionText = '本机保活/自愈执行中…';
    } else if (desktop._lastError) {
      tone = 'error';
      actionText = `上轮异常: ${String(desktop._lastError).slice(0, 48)}`;
    } else if (powerState === 'off') {
      tone = this._isAutoBootArmed(desktop) ? 'warn' : 'off';
      actionText = this._isAutoBootArmed(desktop) ? '已关机 · 自动开机守护待命' : '已关机（未开启自动开机守护）';
    } else if (powerState === 'starting') {
      tone = 'idle';
      actionText = '实例启动中 · 等待进入运行态';
    } else if (powerState === 'queue') {
      tone = 'warn';
      actionText = '实例排队中 · 等待就绪';
    } else if (running && lastAt > 0) {
      tone = 'ok';
      actionText = `心跳+换票保活中（本机累计 ${desktopCycles} 轮）`;
    } else if (running) {
      tone = 'idle';
      actionText = '运行中 · 等待首轮换票';
    } else {
      tone = 'unknown';
      actionText = `状态未知 (${desktop.statusText || '—'})`;
    }

    return {
      instanceId: desktop.instanceId,
      tone,
      running,
      powerState,
      statusText: desktop.statusText || '状态未知',
      actionText,
      intervalSec,
      elapsedSec,
      remainSec,
      lastKeepAliveAt: lastAt,
      cycles: desktopCycles,
      busy: isBusy,
      serverAccepted: desktopCycles > 0,
      autoBootArmed: this._isAutoBootArmed(desktop),
    };
  }
}

module.exports = {
  TeleagentClient,
  LOG_SOURCE,
  WORKER_TICK_MS,
  MIN_KEEPALIVE_SEC,
  buildTeleagentDefaultFeatures,
};
