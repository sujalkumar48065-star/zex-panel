#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PANEL = path.join(ROOT, '..', 'kangle.html');
const PAGE_DIR = path.join(ROOT, '..');
const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login.html': 'login.html',
  '/dashboard.html': 'dashboard.html',
  '/admin.html': 'admin.html',
};
const ASSET_DIR = path.join(ROOT, '..', 'assets');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const PROJECTS_PATH = path.join(ROOT, 'data', 'projects.json');
const HELPER = path.join(ROOT, 'kaggle_ctl.py');
const TEMPLATE = path.join(ROOT, 'templates', 'zex_worker_template.py');
const SECRETS = path.join(ROOT, '.secrets');
const LOG_PATH = path.join(ROOT, 'logs', 'control.log');

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const K = cfg.kaggle;

function readSecret(name, envName) {
  if (envName && process.env[envName]) return String(process.env[envName]).trim();
  try { return fs.readFileSync(path.join(SECRETS, name), 'utf8').trim(); } catch (e) { return ''; }
}
const RENDER_KEY = readSecret('render.key', 'RENDER_API_KEY');
let KAGGLE_CREDS = {};
if (process.env.ZEX_KAGGLE_USER && process.env.ZEX_KAGGLE_KEY) {
  KAGGLE_CREDS = { username: process.env.ZEX_KAGGLE_USER, key: process.env.ZEX_KAGGLE_KEY };
} else {
  try { KAGGLE_CREDS = JSON.parse(readSecret('kaggle.json') || '{}'); } catch (e) {}
}
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const RUNTIME_MODE = String(process.env.ZEX_RUNTIME_MODE || cfg.runtimeMode || 'render').toLowerCase();
function panelUrl() {
  return String(process.env.ZEX_PANEL_URL || cfg.panelUrl || process.env.RENDER_EXTERNAL_URL || 'https://zex-cloud-panel.onrender.com').replace(/\/+$/, '');
}
const runtime = new Map();
const storageCache = new Map();
const workerLogs = { a: [], b: [] };
const workerProjectLogs = new Map();
let workerLastSave = 0;
const CLOCK_TICKS = 100;
const PANEL_PASSWORD = process.env.ZEX_PANEL_PASSWORD || cfg.password;
const PORT = Number(process.env.PORT || cfg.port);
const HOST = process.env.HOST || cfg.host || '0.0.0.0';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_STATE_REPO || '';
const GH_BRANCH = process.env.GITHUB_STATE_BRANCH || 'main';
const GH_ENABLED = !!(GH_TOKEN && GH_REPO);


fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data', 'zex-cloud-a'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data', 'zex-cloud-b'), { recursive: true });
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const SLOTS = ['a', 'b'];
const SLOT_REF = { a: K.kernelA, b: K.kernelB };
const SLOT_FOLDER = {
  a: path.join(ROOT, 'data', 'zex-cloud-a'),
  b: path.join(ROOT, 'data', 'zex-cloud-b'),
};

let state = {
  enabled: !!cfg.autoStart,
  active: 'a',
  sessions: {},
  lastTick: 0,
  lastSync: 0,
  lastBackup: 0,
  lastFailedRotate: 0,
  syncing: false,
  syncReason: '',
  failures: 0,
  deployPending: false,
  handover: null,
  pendingStart: null,
  pendingHandover: null,
  lastRetry: 0,
  forceRotate: false,
  fallback: { active: false, reason: null, at: null },
  history: [],
  apiRequests: 0,
  startedAt: Date.now(),
  settings: { name: 'ZEX PERSONAL PANEL', slug: 'zex' },
  webhooks: [],
  worker: {},
  workerToken: null,
};
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch (e) {}
function normalizeState() {
  for (const slot of SLOTS) {
    if (!state.sessions[slot]) {
      state.sessions[slot] = {
        ref: SLOT_REF[slot], slot, status: 'UNKNOWN', lastPush: null, startedAt: null,
        lastCheck: null, failure: null, role: slot === state.active ? 'active' : 'standby', version: null,
      };
    }
    state.sessions[slot].ref = SLOT_REF[slot];
  }
  state.apiRequests = Number(state.apiRequests || 0);
  state.startedAt = state.startedAt || Date.now();
  state.settings = Object.assign({ name: 'ZEX PERSONAL PANEL', slug: 'zex' }, state.settings || {});
  state.webhooks = Array.isArray(state.webhooks) ? state.webhooks : [];
  state.worker = state.worker && typeof state.worker === 'object' ? state.worker : {};
  if (!state.workerToken) state.workerToken = crypto.randomBytes(24).toString('hex');
}
normalizeState();

const tokens = new Map();
const memLog = [];

function saveState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) { log('FAIL save state: ' + e.message); }
  queueRemoteSave('state');
}

let remoteTimer = null;
let stateDirty = false;
let projectsDirty = false;

function queueRemoteSave(kind) {
  if (!GH_ENABLED) return;
  if (kind === 'state') stateDirty = true;
  if (kind === 'projects') projectsDirty = true;
  if (remoteTimer) clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => { pushRemote().catch((e) => log('STATE remote error: ' + e.message)); }, 15000);
}

async function ghRequest(method, apiPath, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://api.github.com' + apiPath, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + GH_TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zex-cloud-panel',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function ghGetText(file) {
  const r = await ghRequest('GET', '/repos/' + GH_REPO + '/contents/' + file + '?ref=' + GH_BRANCH);
  if (r.status === 404) return { text: null, sha: null };
  if (!r.ok) throw new Error('GET ' + file + ' HTTP ' + r.status);
  return { text: Buffer.from(r.data.content || '', 'base64').toString('utf8'), sha: r.data.sha };
}

async function ghPutText(file, text, message) {
  const cur = await ghGetText(file);
  if (cur.text === text) return false;
  const body = { message, content: Buffer.from(text, 'utf8').toString('base64'), branch: GH_BRANCH };
  if (cur.sha) body.sha = cur.sha;
  const r = await ghRequest('PUT', '/repos/' + GH_REPO + '/contents/' + file, body);
  if (!r.ok) throw new Error('PUT ' + file + ' HTTP ' + r.status);
  return true;
}

async function pushRemote() {
  if (!GH_ENABLED) return;
  if (stateDirty) {
    stateDirty = false;
    const changed = await ghPutText('state.json', JSON.stringify(state, null, 2), 'zex state ' + new Date().toISOString());
    if (changed) log('STATE saved to GitHub');
  }
  if (projectsDirty) {
    projectsDirty = false;
    let text = '{"version":1,"updated_at":null,"projects":[]}\n';
    try { text = fs.readFileSync(PROJECTS_PATH, 'utf8'); } catch (e) {}
    const changed = await ghPutText('projects.json', text, 'zex projects ' + new Date().toISOString());
    if (changed) log('PROJECTS saved to GitHub');
  }
}

async function bootstrap() {
  if (GH_ENABLED) {
    try {
      const st = await ghGetText('state.json');
      if (st.text) {
        const parsed = JSON.parse(st.text);
        state = Object.assign(state, parsed);
        normalizeState();
        log('STATE restored from GitHub');
      }
      const pr = await ghGetText('projects.json');
      if (pr.text) {
        fs.writeFileSync(PROJECTS_PATH, pr.text);
        log('PROJECTS restored from GitHub');
      }
    } catch (e) {
      log('STATE restore failed: ' + e.message);
    }
  }
  server.listen(PORT, HOST, () => {
    log('ZEX CLOUD control listening on http://' + HOST + ':' + PORT);
    log('Session A: ' + K.kernelA + ' | Session B: ' + K.kernelB);
    log('Quota-safe 12h handover; Render fallback ' + ((cfg.render.failoverServiceIds || []).length ? 'configured' : 'not configured'));
    if (!process.env.ZEX_NO_TICK) {
      if (state.enabled) setTimeout(() => tick(true), 4000);
      setInterval(() => tick(false), Math.max(60000, K.pollMs));
    }
    if (process.env.RENDER_EXTERNAL_URL) {
      const url = String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '') + '/api/health';
      const ping = () => fetch(url).catch(() => {});
      setTimeout(ping, 30000);
      setInterval(ping, 4 * 60 * 1000);
      log('Self-ping enabled');
    }
    setTimeout(startAutoRuntime, 2500);
  });
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  memLog.push(line);
  if (memLog.length > 400) memLog.shift();
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
  console.log(line);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let out = '';
    req.on('data', (d) => { out += d; if (out.length > 25 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(out ? JSON.parse(out) : {}); } catch (e) { resolve({}); } });
  });
}

function runHelper(args, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      ZEX_KAGGLE_USER: KAGGLE_CREDS.username || '',
      ZEX_KAGGLE_KEY: KAGGLE_CREDS.key || '',
      KAGGLE_USERNAME: KAGGLE_CREDS.username || '',
      KAGGLE_KEY: KAGGLE_CREDS.key || '',
    });
    const p = spawn('python3', [HELPER, ...args], { env, cwd: ROOT });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').reverse().find((l) => l.startsWith('@@JSON@@'));
      if (line) {
        try { return resolve(JSON.parse(line.slice(8))); } catch (e) {}
      }
      resolve({ ok: false, error: (err || out || 'helper failed').slice(-800), code });
    });
  });
}

function isUp(status) {
  return ['RUNNING', 'QUEUED', 'PENDING'].includes(String(status || '').toUpperCase());
}
function remainingMs(slot) {
  const s = state.sessions[slot];
  if (!s.startedAt) return null;
  return Math.max(0, (s.stopAt || s.startedAt + K.sessionMaxMs) - Date.now());
}
function slotForRef(ref) {
  return SLOT_REF.a === ref ? 'a' : SLOT_REF.b === ref ? 'b' : null;
}

async function kaggleStatus(slot, force) {
  const s = state.sessions[slot];
  if (!force && s.lastCheck && Date.now() - s.lastCheck < 60000) {
    return { ok: true, status: s.status, failure: s.failure, cached: true };
  }
  const r = await runHelper(['status', SLOT_REF[slot]], 90000);
  s.lastCheck = Date.now();
  if (r.ok) {
    s.status = String(r.status || 'UNKNOWN').toUpperCase();
    s.failure = r.failure || null;
  } else {
    s.status = 'UNKNOWN';
    s.failure = r.error || 'status error';
  }
  saveState();
  return { ok: r.ok, status: s.status, failure: s.failure };
}

function loadProjects() {
  try {
    const d = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'));
    return { version: 1, updated_at: d.updated_at || null, projects: Array.isArray(d.projects) ? d.projects : [] };
  } catch (e) {
    return { version: 1, updated_at: null, projects: [] };
  }
}
function saveProjects(reg) {
  reg.version = 1;
  reg.updated_at = new Date().toISOString();
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(reg, null, 2));
  queueRemoteSave('projects');
  return reg;
}

function bundleBase64() {
  const reg = loadProjects();
  const bundle = {
    version: reg.version,
    updated_at: reg.updated_at,
    projects: (reg.projects || []).map((p) => {
      const files = {};
      for (const [name, content] of Object.entries(p.files || {})) {
        if (content && typeof content === 'object' && typeof content.__zex_b64 === 'string') {
          files[name] = content.__zex_b64;
        } else {
          files[name] = Buffer.from(String(content), 'utf8').toString('base64');
        }
      }
      return Object.assign({}, p, { files, run_in_kaggle: RUNTIME_MODE !== 'render' });
    }),
  };
  const raw = Buffer.from(JSON.stringify(bundle), 'utf8');
  return zlib.gzipSync(raw).toString('base64');
}

function renderKernel(slot, role, startAfterEpoch, stopAtEpoch, bundleB64) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const chunks = [];
  for (let i = 0; i < bundleB64.length; i += 76) chunks.push('    "' + bundleB64.slice(i, i + 76) + '"');
  const lines = chunks.length ? chunks.join('\n') : '    ""';
  const out = tpl
    .replace('PANEL_URL = "__PANEL_URL__"', 'PANEL_URL = ' + JSON.stringify(panelUrl()))
    .replace('WORKER_TOKEN = "__WORKER_TOKEN__"', 'WORKER_TOKEN = ' + JSON.stringify(state.workerToken || ''))
    .replace('SLOT = "__SLOT__"', 'SLOT = ' + JSON.stringify(slot.toUpperCase()))
    .replace('ROLE = "__ROLE__"', 'ROLE = ' + JSON.stringify(role))
    .replace('START_AFTER_EPOCH = __START_AFTER__', 'START_AFTER_EPOCH = ' + Number(startAfterEpoch || 0))
    .replace('STOP_AT_EPOCH = __STOP_AT__', 'STOP_AT_EPOCH = ' + Number(stopAtEpoch || 0))
    .replace('__BUNDLE_LINES__', lines);
  fs.writeFileSync(path.join(SLOT_FOLDER[slot], 'zex_worker.py'), out);
  return out.length;
}

async function kagglePush(slot) {
  const ref = SLOT_REF[slot];
  const s = state.sessions[slot];
  log('PUSH start ' + slot + ' (' + ref + ')');
  const r = await runHelper(['push', SLOT_FOLDER[slot]], 10 * 60 * 1000);
  s.lastPush = Date.now();
  const parsed = (r && r.result) || {};
  if (r.ok && !parsed.error) {
    s.version = parsed.versionNumber || s.version || null;
    s.status = 'QUEUED';
    s.failure = null;
    log('PUSH ok ' + slot + ' version=' + (parsed.versionNumber || '?'));
  } else {
    s.status = 'ERROR';
    s.failure = parsed.error || (r && r.error) || 'push failed';
    state.failures++;
    log('PUSH fail ' + slot + ' :: ' + String(s.failure).slice(0, 240));
    r.ok = false;
  }
  saveState();
  return r;
}

function slotStop(slot) {
  const s = state.sessions[slot];
  if (!s) return 0;
  return s.stopAt || (s.startedAt ? s.startedAt + K.sessionMaxMs : 0);
}

async function startSession(slot, startAfterMs, reason) {
  if (state.syncing) return { ok: false, error: 'sync in progress' };
  state.syncing = true;
  state.syncReason = reason || 'start';
  saveState();
  try {
    const now = Date.now();
    const start = Math.floor((now + (startAfterMs || 60000)) / 1000);
    const stop = start + Math.floor(K.sessionMaxMs / 1000);
    renderKernel(slot, 'active', start, stop, bundleBase64());
    const r = await kagglePush(slot);
    const s = state.sessions[slot];
    if (r.ok) {
      s.startedAt = start * 1000;
      s.stopAt = stop * 1000;
      s.role = 'active';
      const other = slot === 'a' ? 'b' : 'a';
      state.sessions[other].role = 'idle';
      state.active = slot;
      state.pendingStart = null;
      state.pendingHandover = null;
      state.handover = null;
      state.deployPending = false;
      state.lastSync = Date.now();
      state.lastBackup = Date.now();
      state.history.push({ at: now, reason: state.syncReason, active: slot });
      if (state.history.length > 40) state.history.shift();
      log('START ok ' + slot + ' starts=' + new Date(start * 1000).toISOString() + ' stop=' + new Date(stop * 1000).toISOString());
      saveState();
      return { ok: true, slot, startAt: start * 1000, stopAt: stop * 1000 };
    }
    s.status = 'ERROR';
    state.pendingStart = { slot, startAt: start * 1000, stopAt: stop * 1000, reason: state.syncReason };
    state.failures++;
    log('START failed ' + slot + ' :: ' + String(s.failure || '').slice(0, 200));
    saveState();
    return { ok: false, slot, error: s.failure || 'push failed', queued: true };
  } finally {
    state.syncing = false;
    state.syncReason = '';
    saveState();
  }
}

async function planHandover(reason) {
  if (state.syncing) return { ok: false, error: 'sync in progress' };
  if (state.handover || state.pendingHandover) return { ok: false, error: 'handover already queued' };
  const cur = state.active || 'a';
  const target = cur === 'a' ? 'b' : 'a';
  const curStop = slotStop(cur) || Date.now();
  const earliest = Math.max(Date.now() + 60000, curStop + 60000);
  const start = Math.floor(earliest / 1000);
  const stop = start + Math.floor(K.sessionMaxMs / 1000);
  state.syncing = true;
  state.syncReason = reason || 'handover';
  saveState();
  try {
    renderKernel(target, 'active', start, stop, bundleBase64());
    const r = await kagglePush(target);
    const s = state.sessions[target];
    if (r.ok) {
      s.startedAt = start * 1000;
      s.stopAt = stop * 1000;
      s.role = 'active';
      state.sessions[cur].role = 'idle';
      state.active = target;
      state.handover = { slot: target, startAt: start * 1000, stopAt: stop * 1000, reason: state.syncReason };
      state.pendingHandover = null;
      state.deployPending = false;
      state.lastSync = Date.now();
      state.lastBackup = Date.now();
      state.history.push({ at: Date.now(), reason: state.syncReason, active: target });
      if (state.history.length > 40) state.history.shift();
      log('HANDOVER ok ' + cur + ' -> ' + target + ' starts=' + new Date(start * 1000).toISOString());
      saveState();
      return { ok: true, slot: target, startAt: start * 1000, stopAt: stop * 1000 };
    }
    state.pendingHandover = { slot: target, startAt: start * 1000, stopAt: stop * 1000, reason: state.syncReason };
    state.failures++;
    log('HANDOVER queued (push failed) ' + target + ' :: ' + String(s.failure || '').slice(0, 200));
    saveState();
    return { ok: false, slot: target, error: s.failure || 'push failed', queued: true };
  } finally {
    state.syncing = false;
    state.syncReason = '';
    saveState();
  }
}

async function retryPending(force) {
  if (!force && Date.now() - (state.lastRetry || 0) < 10 * 60000) return false;
  if (state.pendingStart) {
    const p = state.pendingStart;
    state.pendingStart = null;
    state.lastRetry = Date.now();
    log('RETRY start ' + p.slot);
    await startSession(p.slot, 60000, p.reason || 'retry-start');
    return true;
  }
  if (state.pendingHandover) {
    const p = state.pendingHandover;
    state.pendingHandover = null;
    state.lastRetry = Date.now();
    log('RETRY handover ' + p.slot);
    await planHandover(p.reason || 'retry-handover');
    return true;
  }
  return false;
}

function isSessionRunning(slot) {
  const s = state.sessions[slot];
  if (!s || !s.startedAt) return false;
  if (['ERROR', 'CANCELED', 'COMPLETE'].includes(s.status)) return false;
  return Date.now() < (s.stopAt || s.startedAt + K.sessionMaxMs);
}

async function requestDeploy(reason) {
  state.deployPending = true;
  saveState();
  if (process.env.ZEX_NO_DEPLOY) {
    return { ok: true, queued: true, note: 'Deploy queued (test mode).' };
  }
  const cur = state.active || 'a';
  if (!isSessionRunning(cur) && !state.handover) {
    const r = await startSession(cur, 60000, reason || 'deploy');
    return r.ok ? Object.assign({ deployed: true }, r) : Object.assign({ queued: true }, r);
  }
  return {
    ok: true,
    queued: true,
    active: cur,
    nextAt: (state.handover && state.handover.startAt) || slotStop(cur),
    note: 'Saved. Changes are applied at the next safe handover (no duplicate execution).',
  };
}

async function scheduleHandover(reason) {
  const cur = state.active || 'a';
  const other = cur === 'a' ? 'b' : 'a';
  if (!isSessionRunning(cur)) return startSession(other, 60000, reason);
  const stop = slotStop(cur);
  const lead = Math.min(10 * 60000, K.sessionMaxMs / 10);
  if (stop - Date.now() > lead) {
    state.forceRotate = true;
    saveState();
    log('HANDOVER scheduled at safe stop ' + new Date(stop + 60000).toISOString() + ' (' + reason + ')');
    return { ok: true, scheduled: true, target: other, startAt: stop + 60000, note: 'Scheduled for the safe stop window (no duplicate execution).' };
  }
  return planHandover(reason);
}

function renderRequest(method, apiPath, body) {
  return new Promise((resolve) => {
    if (!RENDER_KEY) return resolve({ ok: false, status: 0, error: 'render key not configured' });
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.render.com',
      path: '/v1' + apiPath,
      method,
      headers: Object.assign({
        Authorization: 'Bearer ' + RENDER_KEY,
        Accept: 'application/json',
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 30000,
    }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => {
        let parsed = out;
        try { parsed = out ? JSON.parse(out) : null; } catch (e) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function renderServices() {
  const r = await renderRequest('GET', '/services?limit=100');
  if (!r.ok) return { ok: false, services: [], error: r.error || ('HTTP ' + r.status) };
  return {
    ok: true,
    services: (r.data || []).map((x) => ({
      id: x.service.id,
      name: x.service.name,
      type: x.service.type,
      url: (x.service.serviceDetails && x.service.serviceDetails.url) || '',
      suspended: x.service.suspended || 'not_suspended',
    })),
  };
}

async function renderFallback(reason) {
  const ids = (cfg.render.failoverServiceIds || []).slice();
  state.fallback = { active: false, reason: reason || 'unknown', at: Date.now() };
  if (!ids.length) {
    log('FALLBACK not configured: ' + (reason || ''));
    saveState();
    return { ok: false, error: 'no authorized Render fallback service configured', services: [] };
  }
  const results = [];
  for (const id of ids) {
    const rr = await renderRequest('POST', '/services/' + id + '/resume');
    const r = await renderRequest('POST', '/services/' + id + '/deploys', { clearCache: 'do_not_clear' });
    log('FALLBACK ' + id + ' resume=' + rr.status + ' deploy=' + r.status);
    results.push({ id, ok: r.ok, resumeStatus: rr.status, deployStatus: r.status, error: r.error || null });
  }
  state.fallback.active = results.some((x) => x.ok);
  saveState();
  return { ok: state.fallback.active, services: results };
}

let ticking = false;
async function tick(force) {
  if (ticking) return;
  ticking = true;
  try {
    state.lastTick = Date.now();
    if (!state.enabled) return;
    await kaggleStatus('a', force);
    await kaggleStatus('b', force);
    if (await retryPending(force)) return;
    const cur = state.active || 'a';
    const s = state.sessions[cur];
    const now = Date.now();
    if (!s.startedAt) {
      log('TICK initial start');
      await startSession(cur, 60000, 'initial');
      return;
    }
    if (state.handover && now > state.handover.startAt + 120000) {
      log('HANDOVER complete; active=' + state.handover.slot);
      state.handover = null;
      saveState();
    }
    const stopAt = s.stopAt || (s.startedAt + K.sessionMaxMs);
    const lead = Math.min(10 * 60000, K.sessionMaxMs / 10);
    if (state.forceRotate && now >= stopAt - lead) {
      state.forceRotate = false;
      await planHandover('manual-rotate');
      return;
    }
    if (['ERROR', 'CANCELED', 'COMPLETE'].includes(s.status) && !state.handover) {
      if (now - (state.lastFailedRotate || 0) < K.minPushGapMs) return;
      log('TICK active session unhealthy: ' + s.status);
      const other = cur === 'a' ? 'b' : 'a';
      const r = await startSession(other, 60000, 'rotate-after-failure');
      if (!r.ok) {
        state.lastFailedRotate = now;
        await renderFallback('kaggle session failure');
      }
      return;
    }
    if (now >= stopAt + 120000 && !state.handover) {
      if (now - (state.lastFailedRotate || 0) < K.minPushGapMs) return;
      log('TICK active session expired; starting next');
      const other = cur === 'a' ? 'b' : 'a';
      const r = await startSession(other, 60000, 'expired');
      if (!r.ok) {
        state.lastFailedRotate = now;
        await renderFallback('kaggle session expired');
      }
      return;
    }
    if (now >= stopAt - lead && !state.handover && !state.pendingHandover) {
      log('TICK handover window; preparing next session');
      const r = await planHandover('rotation');
      if (!r.ok && !r.queued) await renderFallback('kaggle rotation failed');
    }
  } catch (e) {
    log('TICK error: ' + e.message);
  } finally {
    ticking = false;
    saveState();
  }
}

function publicStatus() {
  const sessions = {};
  for (const slot of SLOTS) {
    const s = state.sessions[slot];
    sessions[slot] = {
      slot, ref: s.ref, status: s.status, role: s.role, version: s.version,
      lastPush: s.lastPush, startedAt: s.startedAt, stopAt: s.stopAt, lastCheck: s.lastCheck,
      failure: s.failure, remainingMs: remainingMs(slot), running: isSessionRunning(slot),
      worker: workerStatus(slot) ? {
        receivedAt: workerStatus(slot).receivedAt, ageMs: workerStatus(slot).ageMs,
        stale: workerStatus(slot).stale, role: workerStatus(slot).role,
        projects: (workerStatus(slot).projects || []).length,
      } : null,
    };
  }
  const reg = loadProjects();
  return {
    ok: true,
    enabled: state.enabled,
    active: state.active,
    syncing: state.syncing,
    syncReason: state.syncReason,
    sessions,
    projects: { count: reg.projects.length, updated_at: reg.updated_at },
    runtimeMode: RUNTIME_MODE,
    runtime: runtimeStatus(),
    worker: workerSummary(),
    system: systemMetrics(),
    apiRequests: Number(state.apiRequests || 0),
    startedAt: state.startedAt || null,
    settings: state.settings || { name: 'ZEX PERSONAL PANEL', slug: 'zex' },
    webhooks: (state.webhooks || []).length,
    masterKeyMasked: masterKey().slice(0, 6) + '••••••••' + masterKey().slice(-4),
    history: (state.history || []).slice(-40),
    rotation: { rotateAfterMs: K.rotateAfterMs, sessionMaxMs: K.sessionMaxMs, pollMs: K.pollMs },
    render: { fallbackServiceIds: cfg.render.failoverServiceIds || [], configured: (cfg.render.failoverServiceIds || []).length > 0 },
    renderKey: !!RENDER_KEY,
    kaggle: !!(KAGGLE_CREDS.username && KAGGLE_CREDS.key),
    github: GH_ENABLED,
    fallback: state.fallback,
    lastSync: state.lastSync,
    lastBackup: state.lastBackup,
    lastTick: state.lastTick,
    failures: state.failures,
    deployPending: !!state.deployPending,
    handover: state.handover,
    pending: state.pendingHandover || state.pendingStart || null,
    log: memLog.slice(-120),
    limits: {
      stopSupported: false,
      note: 'Kaggle-first: the active session runs projects and reports live CPU/RAM/storage to this panel. Each worker self-stops at its 12h limit; the next session is prepared in advance with a start time after the old stop, so there is no duplicate execution.',
    },
  };
}


const KINDS = ['website', 'discord_bot', 'telegram_bot', 'api', 'worker'];
const SITE_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
};

function slugify(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 56);
}
function contentBuffer(content) {
  if (content && typeof content === 'object') {
    if (typeof content.__zex_b64 === 'string') return Buffer.from(content.__zex_b64, 'base64');
    if (typeof content.data === 'string') return Buffer.from(content.data, content.encoding === 'base64' ? 'base64' : 'utf8');
  }
  return Buffer.from(String(content == null ? '' : content), 'utf8');
}
function contentText(content) { return contentBuffer(content).toString('utf8'); }
function detectKind(p) {
  if (KINDS.includes(p.kind)) return p.kind;
  const cmd = String(p.start_command || '').toLowerCase();
  if (cmd.includes('http.server') || cmd.includes('serve')) return 'website';
  return 'worker';
}
function detectStartCommand(p) {
  const explicit = String(p.start_command || '').trim();
  if (explicit) return explicit;
  if (p.kind === 'website') return '';
  const files = p.files || {};
  const names = Object.keys(files);
  const find = (cands) => {
    for (const c of cands) {
      if (names.includes(c)) return c;
      const hit = names.find((n) => n.endsWith('/' + c));
      if (hit) return hit;
    }
    return null;
  };
  const pkg = find(['package.json']);
  if (pkg) {
    try {
      const parsed = JSON.parse(contentText(files[pkg]));
      if (parsed.scripts && parsed.scripts.start) return 'npm start';
    } catch (e) {}
  }
  const pyPreferred = {
    discord_bot: ['bot.py', 'main.py', 'app.py', 'index.py', 'run.py', 'server.py'],
    telegram_bot: ['bot.py', 'main.py', 'app.py', 'index.py', 'run.py', 'server.py'],
    api: ['app.py', 'main.py', 'server.py', 'index.py', 'run.py'],
    worker: ['bot.py', 'main.py', 'worker.py', 'app.py', 'run.py', 'index.py'],
  }[p.kind] || ['main.py', 'app.py', 'bot.py', 'worker.py', 'run.py', 'index.py'];
  const py = find(pyPreferred);
  if (py) return 'python3 -u ' + py;
  const pyFiles = names.filter((n) => /\.py$/i.test(n) && !/(^|\/)(setup|conftest)\.py$/i.test(n) && !/(^|\/)(__pycache__|\.venv|venv|site-packages|node_modules)\//.test(n));
  if (pyFiles.length) {
    const rank = (name) => {
      const base = name.split('/').pop().toLowerCase();
      const text = contentText(files[name] || '').slice(0, 200000);
      let score = 0;
      if (pyPreferred.includes(base)) score += 100;
      if (/(bot|user|main|app|run|server|worker|start)/.test(base)) score += 30;
      if (base === '__main__.py') score += 25;
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(text)) score += 90;
      if (/asyncio\.run\s*\(/.test(text)) score += 45;
      if (/(TelegramClient|aiogram|pyrogram|discord\.|bot\.run|client\.run|uvicorn\.run|app\.run|FastAPI\s*\()/.test(text)) score += 35;
      if (/(flask|django|aiohttp|telethon|python-telegram-bot)/i.test(text)) score += 15;
      score -= (name.split('/').length - 1) * 3;
      return score;
    };
    pyFiles.sort((a, b) => rank(b) - rank(a) || a.length - b.length);
    return 'python3 -u ' + pyFiles[0];
  }
  const nodePreferred = {
    discord_bot: ['index.js', 'bot.js', 'main.js', 'server.js'],
    telegram_bot: ['index.js', 'bot.js', 'main.js', 'server.js'],
    api: ['server.js', 'index.js', 'app.js', 'main.js'],
    worker: ['index.js', 'worker.js', 'main.js', 'server.js'],
  }[p.kind] || ['index.js', 'server.js', 'app.js', 'main.js'];
  const node = find(nodePreferred);
  if (node) return 'node ' + node;
  const jsFiles = names.filter((n) => /\.(m?js|cjs)$/i.test(n) && !/(^|\/)(node_modules|dist|build)\//.test(n));
  if (jsFiles.length) {
    const rank = (name) => {
      const base = name.split('/').pop().toLowerCase();
      const text = contentText(files[name] || '').slice(0, 200000);
      let score = 0;
      if (nodePreferred.includes(base)) score += 100;
      if (/(bot|user|main|app|run|server|worker|start|index)/.test(base)) score += 30;
      if (/(listen\s*\(|createServer\s*\(|\.login\s*\(|Telegraf|Client\s*\(|express\s*\()/.test(text)) score += 40;
      score -= (name.split('/').length - 1) * 3;
      return score;
    };
    jsFiles.sort((a, b) => rank(b) - rank(a) || a.length - b.length);
    return 'node ' + jsFiles[0];
  }
  return '';
}
function normalizeProject(raw) {
  const p = Object.assign({}, raw || {});
  p.name = String(p.name || p.id || '').trim();
  p.id = slugify(p.id || p.name);
  p.kind = KINDS.includes(p.kind) ? p.kind : detectKind(p);
  p.files = (p.files && typeof p.files === 'object' && !Array.isArray(p.files)) ? p.files : {};
  p.env = (p.env && typeof p.env === 'object' && !Array.isArray(p.env)) ? p.env : {};
  p.enabled = p.enabled !== false;
  p.auto_start = p.auto_start !== false;
  p.start_command = String(p.start_command || '').trim();
  if (p.kind === 'website') p.start_command = '';
  if (!p.start_command && p.kind !== 'website') p.start_command = detectStartCommand(p);
  if (!p.requirements) {
    const req = p.files['requirements.txt'] || p.files['./requirements.txt'];
    if (req !== undefined) p.requirements = contentText(req).slice(0, 50000);
  }
  p.requirements = String(p.requirements || '');
  p.public_url = p.kind === 'website' ? '/s/' + p.id + '/' : '';
  return p;
}
function projectError(p) {
  if (!p || typeof p !== 'object') return 'project object required';
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(String(p.id || ''))) return 'invalid project id (use a lowercase slug, 2-64 chars)';
  if (!p.name) return 'project name required';
  if (!KINDS.includes(p.kind)) return 'invalid project kind';
  if (!p.files || typeof p.files !== 'object' || Array.isArray(p.files)) return 'files must be an object';
  if (!p.env || typeof p.env !== 'object' || Array.isArray(p.env)) return 'env must be an object';
  if (p.kind !== 'website' && !String(p.start_command || '').trim()) {
    return 'Could not detect a start command. Upload package.json, main.py, app.py, bot.py or index.js (or add a start command).';
  }
  if (Buffer.byteLength(JSON.stringify(p.files)) > 20 * 1024 * 1024) return 'project files exceed the 20 MB limit';
  return null;
}

function runtimeEntry(id) {
  let r = runtime.get(id);
  if (!r) {
    r = {
      id, status: 'stopped', proc: null, logs: [], restarts: 0,
      startedAt: null, lastExit: null, error: null, stopRequested: false,
      starting: false, timer: null, installing: false, cancelled: false,
    };
    runtime.set(id, r);
  }
  return r;
}
function runtimeLog(r, line) {
  const text = String(line == null ? '' : line).replace(/\r$/, '');
  if (!text.trim()) return;
  r.logs.push('[' + new Date().toISOString() + '] ' + text);
  if (r.logs.length > 600) r.logs.shift();
}
function safeRuntimePath(base, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter((x) => x && x !== '.' && x !== '..');
  return path.join(base, ...parts);
}
function syncRuntimeFiles(project, resetDeps) {
  storageCache.delete(project.id);
  const dir = path.join(RUNTIME_DIR, project.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(project.files || {})) {
    const target = safeRuntimePath(dir, rel);
    if (!target.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contentBuffer(content));
  }
  if (resetDeps) {
    try { fs.rmSync(path.join(dir, '.zex-deps-ready'), { force: true }); } catch (e) {}
  }
  return dir;
}
function runCaptured(command, args, cwd, r, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    try {
      child = spawn(command, args, { cwd, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      runtimeLog(r, '[install] ' + e.message);
      return resolve(false);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      if (!done) { done = true; runtimeLog(r, '[install] timeout'); resolve(false); }
    }, timeoutMs || 300000);
    const onData = (buf) => {
      String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => runtimeLog(r, '[install] ' + l));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      if (!done) { done = true; runtimeLog(r, '[install] ' + e.message); resolve(false); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!done) { done = true; resolve(code === 0); }
    });
  });
}
async function installRuntimeDeps(project, dir, r) {
  const marker = path.join(dir, '.zex-deps-ready');
  if (fs.existsSync(marker)) return true;
  const req = path.join(dir, 'requirements.txt');
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(req) && !fs.existsSync(pkg)) {
    try { fs.writeFileSync(marker, 'no dependencies\n'); } catch (e) {}
    return true;
  }
  r.installing = true;
  r.status = 'installing';
  runtimeLog(r, 'installing dependencies…');
  let ok = true;
  if (fs.existsSync(req)) {
    const pip = await runCaptured('python3', ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--break-system-packages', '-r', 'requirements.txt'], dir, r, 300000);
    if (!pip) { ok = false; runtimeLog(r, 'pip install failed'); }
  }
  if (fs.existsSync(pkg) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    const npm = await runCaptured('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], dir, r, 300000);
    if (!npm) { ok = false; runtimeLog(r, 'npm install failed'); }
  }
  r.installing = false;
  if (ok) { try { fs.writeFileSync(marker, 'done\n'); } catch (e) {} }
  return ok;
}
function stopProject(id, silent) {
  const r = runtimeEntry(id);
  r.stopRequested = true;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  const child = r.proc;
  if (!child) { r.status = 'stopped'; r.proc = null; return Promise.resolve(); }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      r.proc = null;
      r.status = 'stopped';
      if (!silent) runtimeLog(r, 'stopped');
      resolve();
    };
    child.once('exit', finish);
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} } }, 4000);
    setTimeout(finish, 7000);
  });
}
async function startProject(id, opts) {
  opts = opts || {};
  const project = (loadProjects().projects || []).find((x) => x.id === id);
  const r = runtimeEntry(id);
  if (!project) { r.status = 'error'; r.error = 'project not found'; return { ok: false, error: r.error }; }
  if (project.kind === 'website') {
    r.status = 'static';
    r.error = null;
    return { ok: true, static: true };
  }
  if (project.enabled === false) { r.status = 'stopped'; return { ok: false, error: 'project disabled' }; }
  if (!opts.force && r.proc && r.status === 'running') return { ok: true, alreadyRunning: true, pid: r.proc.pid };
  if (r.starting) return { ok: false, error: 'start already in progress' };
  r.cancelled = false;
  r.starting = true;
  try {
    if (r.proc) await stopProject(id, true);
    if (!project.start_command) project.start_command = detectStartCommand(project);
    if (!project.start_command) {
      r.status = 'error'; r.error = 'No start command could be detected';
      runtimeLog(r, r.error);
      return { ok: false, error: r.error };
    }
    r.stopRequested = false;
    r.error = null;
    r.lastExit = null;
    if (!opts.restart) r.restarts = 0;
    const dir = syncRuntimeFiles(project, false);
    const deps = await installRuntimeDeps(project, dir, r);
    if (!deps) {
      r.status = 'error'; r.error = 'Dependency install failed';
      runtimeLog(r, r.error);
      return { ok: false, error: r.error };
    }
    const still = (loadProjects().projects || []).find((x) => x.id === id);
    if (!still || r.cancelled) {
      r.status = 'stopped';
      runtimeLog(r, 'start cancelled (project removed)');
      return { ok: false, error: 'project removed' };
    }
    const env = Object.assign({}, process.env, project.env || {}, {
      PYTHONUNBUFFERED: '1', NODE_ENV: 'production', ZEX_PROJECT_ID: project.id,
      PORT: String((project.env && project.env.PORT) || (4100 + runtime.size)),
    });
    const child = spawn(project.start_command, { shell: true, cwd: dir, env, detached: true });
    r.proc = child;
    r.status = 'running';
    r.startedAt = Date.now();
    r.error = null;
    runtimeLog(r, 'started pid=' + child.pid + ' · ' + project.start_command);
    const onData = (buf) => String(buf).split(/\r?\n/).forEach((l) => runtimeLog(r, l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { runtimeLog(r, 'process error: ' + e.message); r.error = e.message; });
    child.on('exit', (code, signal) => {
      if (r.proc !== child) return;
      r.proc = null;
      r.lastExit = { code, signal, at: Date.now() };
      if (r.stopRequested) { r.status = 'stopped'; return; }
      const current = (loadProjects().projects || []).find((x) => x.id === id);
      if (!current || current.enabled === false || current.auto_start === false) { r.status = 'stopped'; return; }
      r.restarts++;
      if (r.restarts <= 5) {
        r.status = 'restarting';
        r.error = 'Exited with code ' + code + '; restarting';
        runtimeLog(r, r.error);
        r.timer = setTimeout(() => { startProject(id, { auto: true, restart: true }); }, Math.min(30000, 3000 * r.restarts));
      } else {
        r.status = 'error';
        r.error = 'Crashed repeatedly (last code ' + code + ')';
        runtimeLog(r, r.error);
      }
    });
    return { ok: true, pid: child.pid };
  } catch (e) {
    r.status = 'error'; r.error = e.message; runtimeLog(r, 'start failed: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    r.starting = false;
  }
}
async function restartProject(id) {
  await stopProject(id, true);
  const reg = loadProjects();
  const p = (reg.projects || []).find((x) => x.id === id);
  if (p) { p.auto_start = true; saveProjects(reg); }
  return startProject(id, { manual: true });
}
function setProjectAutoStart(id, value) {
  const reg = loadProjects();
  const p = (reg.projects || []).find((x) => x.id === id);
  if (!p) return false;
  p.auto_start = !!value;
  saveProjects(reg);
  return true;
}
function readProcStat(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const f = raw.slice(close + 2).trim().split(/\s+/);
    return {
      pid: Number(pid), state: f[0], ppid: Number(f[1]),
      utime: Number(f[11] || 0), stime: Number(f[12] || 0),
      threads: Number(f[17] || 0), rssPages: Number(f[21] || 0),
    };
  } catch (e) { return null; }
}
function procTable() {
  const table = new Map();
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch (e) { return table; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const row = readProcStat(name);
    if (row) table.set(row.pid, row);
  }
  return table;
}
function processTreeIds(rootPid, table) {
  const children = new Map();
  for (const row of table.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const ids = [];
  const seen = new Set();
  const stack = [Number(rootPid)];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    ids.push(pid);
    for (const child of children.get(pid) || []) stack.push(child);
  }
  return ids;
}
function projectProcessStats(rootPid, runtimeRow) {
  if (!rootPid) return { pid: null, memoryMb: null, cpuPercent: null, processes: 0 };
  const table = procTable();
  const ids = processTreeIds(rootPid, table);
  let rssPages = 0;
  let ticks = 0;
  let processes = 0;
  for (const pid of ids) {
    const row = table.get(pid);
    if (!row) continue;
    processes++;
    rssPages += row.rssPages;
    ticks += row.utime + row.stime;
  }
  const memoryMb = Math.round(rssPages * 4096 / 1048576 * 10) / 10;
  let cpuPercent = null;
  if (runtimeRow) {
    const prev = runtimeRow.cpuSample;
    const now = Date.now();
    if (prev && now > prev.at && ticks >= prev.ticks) {
      const elapsed = (now - prev.at) / 1000;
      if (elapsed > 0) cpuPercent = Math.max(0, Math.round((ticks - prev.ticks) / (elapsed * CLOCK_TICKS) * 1000) / 10);
    }
    runtimeRow.cpuSample = { ticks, at: now };
  }
  return { pid: Number(rootPid), memoryMb, cpuPercent, processes };
}
function readMemInfo() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
  } catch (e) {}
  return out;
}
function cgroupMemory() {
  const pairs = [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes'],
  ];
  for (const [usagePath, limitPath] of pairs) {
    try {
      const used = Number(fs.readFileSync(usagePath, 'utf8').trim());
      const rawLimit = fs.readFileSync(limitPath, 'utf8').trim();
      const limit = rawLimit === 'max' ? 0 : Number(rawLimit);
      if (Number.isFinite(used) && used > 0 && Number.isFinite(limit) && limit > 0 && limit < 1e15) {
        return { totalBytes: limit, usedBytes: used, availableBytes: Math.max(0, limit - used), source: 'container' };
      }
    } catch (e) {}
  }
  return null;
}
let lastCpuTimes = null;
function readCpuTimes() {
  try {
    const parts = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idle = (parts[3] || 0) + (parts[4] || 0);
    return { total, idle };
  } catch (e) { return null; }
}
function systemCpuPercent() {
  const cur = readCpuTimes();
  if (cur && lastCpuTimes && cur.total > lastCpuTimes.total) {
    const total = cur.total - lastCpuTimes.total;
    const idle = cur.idle - lastCpuTimes.idle;
    lastCpuTimes = cur;
    return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
  }
  if (cur) lastCpuTimes = cur;
  const cores = os.cpus().length || 1;
  return Math.max(0, Math.min(100, Math.round(os.loadavg()[0] / cores * 1000) / 10));
}
function readUptimeMs() {
  try { return Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000); }
  catch (e) { return Math.round(os.uptime() * 1000); }
}
function diskMetrics() {
  try {
    const st = fs.statfsSync(ROOT);
    const totalBytes = Number(st.bsize) * Number(st.blocks);
    const freeBytes = Number(st.bsize) * Number(st.bavail);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes, freeBytes, usedBytes,
      percent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : 0,
    };
  } catch (e) { return null; }
}
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const target = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(target); continue; }
      if (!ent.isFile()) continue;
      try { bytes += fs.statSync(target).size; files++; } catch (e) {}
    }
  }
  return { bytes, files };
}
function projectStorage(project) {
  const id = project.id;
  const cached = storageCache.get(id);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  let codeBytes = 0;
  let fileCount = 0;
  for (const content of Object.values(project.files || {})) {
    codeBytes += contentBuffer(content).length;
    fileCount++;
  }
  let diskBytes = codeBytes;
  let diskFiles = fileCount;
  if (project.kind !== 'website') {
    const runtimeDir = path.join(RUNTIME_DIR, id);
    try {
      if (fs.existsSync(runtimeDir)) {
        const d = dirSize(runtimeDir);
        diskBytes = Math.max(codeBytes, d.bytes);
        diskFiles = Math.max(fileCount, d.files);
      }
    } catch (e) {}
  }
  const value = { codeBytes, diskBytes, files: fileCount, diskFiles };
  storageCache.set(id, { at: Date.now(), value });
  return value;
}
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function workerStatus(slot) {
  const w = state.worker && state.worker[slot];
  if (!w || !w.receivedAt) return null;
  const ageMs = Math.max(0, Date.now() - Number(w.receivedAt || 0));
  return Object.assign({}, w, { ageMs, stale: ageMs > 150000 });
}
function workerSummary() {
  const sessions = {};
  for (const slot of SLOTS) {
    const w = workerStatus(slot);
    if (!w) continue;
    sessions[slot] = {
      slot, role: w.role || 'unknown', receivedAt: w.receivedAt, ageMs: w.ageMs, stale: w.stale,
      session: w.session || null, system: w.system || null,
      projects: (w.projects || []).map((p) => Object.assign({}, p)),
    };
  }
  let active = sessions[state.active] && !sessions[state.active].stale ? sessions[state.active] : null;
  if (!active) active = SLOTS.map((s) => sessions[s]).find((x) => x && !x.stale) || null;
  return { active, sessions, tokenSet: !!state.workerToken };
}
function sanitizeWorkerSystem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const memory = raw.memory && typeof raw.memory === 'object' ? {
    totalBytes: numOrNull(raw.memory.totalBytes), usedBytes: numOrNull(raw.memory.usedBytes),
    availableBytes: numOrNull(raw.memory.availableBytes), percent: numOrNull(raw.memory.percent),
  } : null;
  const disk = raw.disk && typeof raw.disk === 'object' ? {
    totalBytes: numOrNull(raw.disk.totalBytes), usedBytes: numOrNull(raw.disk.usedBytes),
    freeBytes: numOrNull(raw.disk.freeBytes), percent: numOrNull(raw.disk.percent),
  } : null;
  return {
    cpuPercent: numOrNull(raw.cpuPercent), cpuCount: numOrNull(raw.cpuCount),
    loadavg: Array.isArray(raw.loadavg) ? raw.loadavg.slice(0, 3).map((x) => numOrNull(x)) : [],
    memory, disk, uptimeMs: numOrNull(raw.uptimeMs), platform: raw.platform ? String(raw.platform).slice(0, 40) : null,
  };
}
function sanitizeWorkerSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    startedAt: raw.startedAt ? String(raw.startedAt).slice(0, 40) : null,
    stopAt: numOrNull(raw.stopAt), remainingMs: numOrNull(raw.remainingMs),
    elapsedSeconds: numOrNull(raw.elapsedSeconds), startAfterEpoch: numOrNull(raw.startAfterEpoch),
    stopAtEpoch: numOrNull(raw.stopAtEpoch), version: raw.version ? String(raw.version).slice(0, 60) : null,
  };
}
function ingestWorkerReport(body, slot) {
  const projects = (Array.isArray(body.projects) ? body.projects : []).slice(0, 100).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const id = slugify(p.id);
    if (!id) return null;
    const logs = Array.isArray(p.logs) ? p.logs.slice(-120).map((l) => String(l == null ? '' : l).slice(0, 1200)) : [];
    if (logs.length) {
      const prev = workerProjectLogs.get(id) || [];
      workerProjectLogs.set(id, prev.concat(logs).slice(-600));
    }
    return {
      id, name: String(p.name || id).slice(0, 120), kind: KINDS.includes(p.kind) ? p.kind : 'worker',
      status: String(p.status || 'stopped').slice(0, 30), pid: numOrNull(p.pid),
      cpuPercent: numOrNull(p.cpuPercent), memoryMb: numOrNull(p.memoryMb),
      processes: numOrNull(p.processes), storageBytes: numOrNull(p.storageBytes),
      codeBytes: numOrNull(p.codeBytes), depsBytes: numOrNull(p.depsBytes),
      startedAt: numOrNull(p.startedAt), uptimeMs: numOrNull(p.uptimeMs),
      restarts: numOrNull(p.restarts) || 0, error: p.error ? String(p.error).slice(0, 300) : null,
      command: p.command ? String(p.command).slice(0, 300) : '',
      autoStart: p.autoStart !== false,
    };
  }).filter(Boolean);
  const logs = Array.isArray(body.logs) ? body.logs.slice(-300).map((l) => String(l == null ? '' : l).slice(0, 2000)) : [];
  if (logs.length) workerLogs[slot] = workerLogs[slot].concat(logs).slice(-800);
  const stored = {
    slot, role: String(body.role || 'active').slice(0, 30), receivedAt: Date.now(),
    session: sanitizeWorkerSession(body.session), system: sanitizeWorkerSystem(body.system),
    projects, logs: [],
  };
  state.worker = state.worker || {};
  state.worker[slot] = stored;
  if (!workerLastSave || Date.now() - workerLastSave > 120000) {
    workerLastSave = Date.now();
    saveState();
  }
  return stored;
}
function kaggleRuntimeRows() {
  const reg = loadProjects();
  const byId = new Map();
  for (const slot of SLOTS) {
    const w = workerStatus(slot);
    if (!w || w.stale) continue;
    for (const row of w.projects || []) {
      const p = (reg.projects || []).find((x) => x.id === row.id);
      if (!p || p.kind === 'website') continue;
      const storage = projectStorage(p);
      const codeBytes = row.codeBytes == null ? storage.codeBytes : row.codeBytes;
      const storageBytes = row.storageBytes == null ? storage.diskBytes : row.storageBytes;
      byId.set(row.id, {
        id: row.id, name: p.name || row.name || row.id, kind: p.kind || row.kind || 'worker',
        status: row.status || 'stopped', pid: row.pid, memoryMb: row.memoryMb,
        cpuPercent: row.cpuPercent, processes: row.processes, startedAt: row.startedAt,
        uptimeMs: row.uptimeMs || 0, restarts: row.restarts || 0, error: row.error || null,
        lastExit: null, autoStart: row.autoStart !== false, installing: row.status === 'installing',
        command: row.command || p.start_command || '', public_url: p.public_url || '',
        storageBytes, codeBytes, depsBytes: row.depsBytes == null ? Math.max(0, storageBytes - codeBytes) : row.depsBytes,
        source: 'kaggle', slot, heartbeatAt: w.receivedAt,
        logs: (workerProjectLogs.get(row.id) || []).slice(-30),
      });
    }
  }
  return [...byId.values()];
}
function systemMetrics() {
  const meminfo = readMemInfo();
  const cg = cgroupMemory();
  const memTotal = (cg && cg.totalBytes) || meminfo.MemTotal || 0;
  const memUsed = (cg && cg.usedBytes) || (meminfo.MemTotal && meminfo.MemAvailable ? meminfo.MemTotal - meminfo.MemAvailable : 0);
  const memory = {
    totalBytes: memTotal,
    usedBytes: memUsed,
    availableBytes: Math.max(0, memTotal - memUsed),
    percent: memTotal ? Math.round(memUsed / memTotal * 1000) / 10 : 0,
    source: cg ? 'container' : 'system',
  };
  const disk = diskMetrics();
  const cpuPercent = systemCpuPercent();
  const cpus = os.cpus();
  return {
    cpuPercent,
    cpuCount: cpus.length || 1,
    loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
    memory,
    disk,
    uptimeMs: readUptimeMs(),
    panelUptimeMs: Math.round(process.uptime() * 1000),
    platform: process.platform,
    node: process.version,
  };
}
function runtimeStatus() {
  const reg = loadProjects();
  for (const p of reg.projects || []) {
    if (p.kind !== 'website' && !runtime.has(p.id)) runtimeEntry(p.id);
  }
  const rows = [...runtime.values()].filter((r) => (reg.projects || []).some((x) => x.id === r.id && x.kind !== 'website')).map((r) => {
    const p = (reg.projects || []).find((x) => x.id === r.id) || {};
    const ps = projectProcessStats(r.proc ? r.proc.pid : null, r);
    return {
      id: r.id, name: p.name || r.id, kind: p.kind || 'worker',
      status: r.status, pid: ps.pid, memoryMb: ps.memoryMb, cpuPercent: ps.cpuPercent, processes: ps.processes,
      startedAt: r.startedAt, uptimeMs: r.startedAt && r.status === 'running' ? Date.now() - r.startedAt : 0,
      restarts: r.restarts, error: r.error, lastExit: r.lastExit,
      autoStart: p.auto_start !== false, installing: r.installing,
      command: p.start_command || '', public_url: p.public_url || '',
      storageBytes: projectStorage(p).diskBytes, source: 'render',
      logs: r.logs.slice(-30),
    };
  });
  const merged = new Map(rows.map((r) => [r.id, r]));
  for (const row of kaggleRuntimeRows()) {
    const cur = merged.get(row.id);
    if (!cur || cur.status !== 'running' || row.status === 'running') merged.set(row.id, row);
  }
  return [...merged.values()];
}
function metricsSnapshot() {
  const reg = loadProjects();
  const rows = runtimeStatus();
  const byId = {};
  for (const row of rows) byId[row.id] = row;
  const projects = (reg.projects || []).map((p) => {
    const live = byId[p.id] || {};
    const storage = projectStorage(p);
    const storageBytes = live.source === 'kaggle' && live.storageBytes != null ? live.storageBytes : storage.diskBytes;
    const codeBytes = live.codeBytes != null ? live.codeBytes : storage.codeBytes;
    const depsBytes = live.depsBytes != null ? live.depsBytes : Math.max(0, storageBytes - codeBytes);
    return {
      id: p.id, name: p.name || p.id, kind: p.kind,
      status: p.kind === 'website' ? 'static' : (live.status || 'stopped'),
      pid: live.pid || null,
      cpuPercent: live.cpuPercent == null ? null : live.cpuPercent,
      memoryMb: live.memoryMb == null ? null : live.memoryMb,
      storageBytes, codeBytes, depsBytes,
      files: storage.files,
      uptimeMs: live.uptimeMs || 0,
      restarts: live.restarts || 0,
      autoStart: p.auto_start !== false,
      error: live.error || null,
      source: live.source || (p.kind === 'website' ? 'panel' : 'render'),
      slot: live.slot || null,
      heartbeatAt: live.heartbeatAt || null,
      public_url: p.public_url || '',
    };
  });
  const totals = {
    projects: projects.length,
    running: projects.filter((p) => p.status === 'running').length,
    errors: projects.filter((p) => p.status === 'error').length,
    stopped: projects.filter((p) => p.status === 'stopped' || p.status === 'static').length,
    storageBytes: projects.reduce((a, p) => a + (p.storageBytes || 0), 0),
    memoryMb: Math.round(projects.reduce((a, p) => a + (p.memoryMb || 0), 0) * 10) / 10,
  };
  return { ok: true, at: Date.now(), system: systemMetrics(), worker: workerSummary(), projects, totals };
}
function runtimeLogs(id) {
  const workerLog = workerProjectLogs.get(id) || [];
  const r = runtime.get(id);
  if (workerLog.length && (!r || !r.proc || r.status !== 'running')) return workerLog.slice(-400);
  if (r && r.logs.length) return r.logs.slice(-400);
  return workerLog.slice(-400);
}
function startAutoRuntime() {
  if (RUNTIME_MODE !== 'render' || process.env.ZEX_NO_RUNTIME) return;
  const reg = loadProjects();
  (reg.projects || []).forEach((p, i) => {
    if (p.kind === 'website' || p.enabled === false || p.auto_start === false) return;
    setTimeout(() => startProject(p.id, { auto: true }), 1500 + i * 1200);
  });
}
async function stopAllRuntime() {
  await Promise.all([...runtime.keys()].map((id) => stopProject(id, true)));
}

function masterKey() {
  if (!state.masterKey) {
    state.masterKey = crypto.randomBytes(24).toString('hex');
    saveState();
  }
  return state.masterKey;
}
function apiPathForProject(p) {
  return p.kind === 'website' ? '/s/' + p.id + '/' : '';
}
function siteNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end('404 — site not found');
}
function serveSite(req, res, url) {
  const m = String(url.pathname || '').match(/^\/s\/([a-z0-9][a-z0-9._-]{1,63})(?:\/(.*))?$/);
  if (!m) return siteNotFound(res);
  const id = m[1];
  const reg = loadProjects();
  const project = (reg.projects || []).find((x) => x.id === id);
  if (!project || project.kind !== 'website' || project.enabled === false) return siteNotFound(res);
  let rel = m[2] || '';
  try { rel = decodeURIComponent(rel); } catch (e) { rel = ''; }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  let file = path.posix.normalize(rel || 'index.html');
  if (file === '.' || file === '') file = 'index.html';
  if (file.startsWith('..') || file.split('/').some((seg) => seg.startsWith('.'))) return siteNotFound(res);
  const files = project.files || {};
  let content = files[file];
  if (content === undefined && !path.posix.extname(file)) {
    if (files[file + '/index.html'] !== undefined) { file += '/index.html'; content = files[file]; }
    else if (files[file + '.html'] !== undefined) { file += '.html'; content = files[file]; }
  }
  if (content === undefined && (!rel || rel.endsWith('/'))) {
    const index = Object.keys(files).find((n) => /^index\.html?$/i.test(n));
    if (index) { file = index; content = files[index]; }
  }
  if (content === undefined) {
    const firstHtml = Object.keys(files).find((n) => /\.html?$/i.test(n));
    if (firstHtml && (!rel || rel === 'index.html')) { file = firstHtml; content = files[firstHtml]; }
  }
  if (content === undefined) return siteNotFound(res);
  const buf = contentBuffer(content);
  const mime = SITE_MIME[path.posix.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  res.writeHead(200, headers);
  return res.end(req.method === 'HEAD' ? undefined : buf);
}
function serveAsset(req, res, url) {
  const name = String(url.pathname || '').replace(/^\/assets\//, '');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(res, 404, { ok: false, error: 'not found' });
  const target = path.join(ASSET_DIR, name);
  if (!target.startsWith(ASSET_DIR + path.sep)) return json(res, 404, { ok: false, error: 'not found' });
  let buf;
  try { buf = fs.readFileSync(target); } catch (e) { return json(res, 404, { ok: false, error: 'not found' }); }
  const mime = SITE_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=300' });
  return res.end(req.method === 'HEAD' ? undefined : buf);
}
function fireWebhooks(event, payload) {
  const hooks = (state.webhooks || []).filter((w) => w && w.enabled !== false && (!w.event || w.event === event));
  for (const w of hooks) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    fetch(w.url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'zex-cloud-panel' },
      body: JSON.stringify({ event, at: new Date().toISOString(), data: payload }),
    }).then((r) => log('WEBHOOK ' + event + ' -> ' + w.url + ' HTTP ' + r.status))
      .catch((e) => log('WEBHOOK failed ' + event + ' -> ' + w.url + ': ' + e.message))
      .finally(() => clearTimeout(timer));
  }
}



const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (PAGES[p]) {
      let html;
      try { html = fs.readFileSync(path.join(PAGE_DIR, PAGES[p]), 'utf8'); }
      catch (e) { return json(res, 404, { ok: false, error: 'page not found' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (p === '/kangle.html') {
      res.writeHead(302, { Location: '/dashboard.html' });
      return res.end();
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.startsWith('/assets/')) return serveAsset(req, res, url);
    if (p === '/s' || p.startsWith('/s/')) return serveSite(req, res, url);
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (String(b.password || '') !== String(PANEL_PASSWORD)) {
        await new Promise((r) => setTimeout(r, 400));
        return json(res, 401, { ok: false, error: 'wrong password' });
      }
      const t = crypto.randomBytes(24).toString('hex');
      tokens.set(t, Date.now() + 12 * 3600 * 1000);
      return json(res, 200, { ok: true, token: t });
    }
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/worker/report' && req.method === 'POST') {
      const supplied = String(req.headers['x-zex-worker-token'] || '');
      const expected = String(state.workerToken || '');
      const a = Buffer.from(supplied);
      const b = Buffer.from(expected);
      if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return json(res, 401, { ok: false, error: 'invalid worker token' });
      }
      const body = await readBody(req);
      const slot = String(body.slot || '').toLowerCase() === 'b' ? 'b' : 'a';
      const stored = ingestWorkerReport(body, slot);
      log('WORKER report slot=' + slot.toUpperCase() + ' projects=' + stored.projects.length + ' cpu=' + (stored.system && stored.system.cpuPercent != null ? stored.system.cpuPercent : '?') + '%');
      return json(res, 200, { ok: true, slot, receivedAt: stored.receivedAt });
    }
    if (!auth(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/status') {
      return json(res, 200, publicStatus());
    }
    if (p === '/api/metrics' && req.method === 'GET') {
      return json(res, 200, metricsSnapshot());
    }
    if (p === '/api/worker' && req.method === 'GET') {
      return json(res, 200, Object.assign({ ok: true }, workerSummary()));
    }
    if (p === '/api/logs') {
      return json(res, 200, { ok: true, log: memLog.slice(-300) });
    }
    if (p === '/api/backups') {
      return json(res, 200, {
        ok: true, lastBackup: state.lastBackup || null, lastSync: state.lastSync || null,
        history: (state.history || []).slice(-40).reverse(),
      });
    }
    if (p === '/api/runtime' && req.method === 'GET') {
      return json(res, 200, { ok: true, mode: RUNTIME_MODE, projects: runtimeStatus() });
    }
    if (p === '/api/runtime/logs' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      return json(res, 200, { ok: true, id, log: runtimeLogs(id) });
    }
    if (p === '/api/runtime/start' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      setProjectAutoStart(id, true);
      const r = await startProject(id, { manual: true });
      return json(res, r.ok ? 200 : 400, Object.assign({ runtime: runtimeStatus() }, r));
    }
    if (p === '/api/runtime/stop' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      setProjectAutoStart(id, false);
      await stopProject(id, false);
      return json(res, 200, { ok: true, runtime: runtimeStatus() });
    }
    if (p === '/api/runtime/restart' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      const r = await restartProject(id);
      return json(res, r.ok ? 200 : 400, Object.assign({ runtime: runtimeStatus() }, r));
    }
    if (p === '/api/key' && req.method === 'GET') {
      return json(res, 200, { ok: true, key: masterKey() });
    }
    if (p === '/api/key' && req.method === 'POST') {
      state.masterKey = crypto.randomBytes(24).toString('hex');
      saveState();
      log('MASTER key rotated');
      return json(res, 200, { ok: true, key: state.masterKey });
    }
    if (p === '/api/settings' && req.method === 'GET') {
      return json(res, 200, { ok: true, settings: state.settings || {} });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const next = Object.assign({}, state.settings || {});
      if (b.name != null) next.name = String(b.name).trim().slice(0, 80) || 'ZEX PERSONAL PANEL';
      if (b.slug != null) next.slug = slugify(b.slug) || 'zex';
      if (b.reducedMotion != null) next.reducedMotion = !!b.reducedMotion;
      if (b.compact != null) next.compact = !!b.compact;
      state.settings = next;
      saveState();
      log('SETTINGS updated');
      return json(res, 200, { ok: true, settings: next });
    }
    if (p === '/api/webhooks' && req.method === 'GET') {
      return json(res, 200, { ok: true, webhooks: state.webhooks || [] });
    }
    if (p === '/api/webhooks' && req.method === 'POST') {
      const b = await readBody(req);
      const w = b.webhook || {};
      const url = String(w.url || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return json(res, 400, { ok: false, error: 'valid http(s) webhook URL required' });
      const hook = {
        id: slugify(w.id || '') || ('wh-' + crypto.randomBytes(3).toString('hex')),
        event: String(w.event || 'project.saved').trim().slice(0, 60),
        url,
        enabled: w.enabled !== false,
      };
      state.webhooks = (state.webhooks || []).filter((x) => x.id !== hook.id);
      state.webhooks.push(hook);
      saveState();
      log('WEBHOOK saved: ' + hook.id);
      return json(res, 200, { ok: true, webhook: hook, webhooks: state.webhooks });
    }
    if (p === '/api/webhooks' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      state.webhooks = (state.webhooks || []).filter((x) => x.id !== id);
      saveState();
      return json(res, 200, { ok: true, webhooks: state.webhooks });
    }
    if (p === '/api/projects' && req.method === 'GET') {
      return json(res, 200, Object.assign({ ok: true }, loadProjects()));
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      const project = normalizeProject(b.project);
      const err = projectError(project);
      if (err) return json(res, 400, { ok: false, error: err });
      const reg = loadProjects();
      const idx = reg.projects.findIndex((x) => x.id === project.id);
      if (idx >= 0) reg.projects[idx] = project; else reg.projects.push(project);
      saveProjects(reg);
      log('PROJECT saved: ' + project.id + ' kind=' + project.kind + ' cmd=' + (project.start_command || '—'));
      if (RUNTIME_MODE === 'render' && !process.env.ZEX_NO_RUNTIME) {
        if (project.kind === 'website') {
          stopProject(project.id, true);
        } else {
          syncRuntimeFiles(project, true);
          if (project.auto_start === false) stopProject(project.id, true);
          else setTimeout(() => { startProject(project.id, { manual: true, force: true }); }, 200);
        }
      }
      fireWebhooks('project.saved', { id: project.id, kind: project.kind, name: project.name });
      const dep = await requestDeploy('project-save');
      return json(res, 200, { ok: true, project, public_url: apiPathForProject(project), deploy: dep });
    }
    if (p === '/api/projects' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { ok: false, error: 'id required' });
      const reg = loadProjects();
      const before = reg.projects.length;
      reg.projects = reg.projects.filter((x) => x.id !== id);
      saveProjects(reg);
      storageCache.delete(id);
      log('PROJECT deleted: ' + id + ' (' + (before - reg.projects.length) + ')');
      if (RUNTIME_MODE === 'render' && !process.env.ZEX_NO_RUNTIME) {
        const rr = runtimeEntry(id);
        rr.cancelled = true;
        rr.stopRequested = true;
        stopProject(id, true).then(() => { runtime.delete(id); try { fs.rmSync(path.join(RUNTIME_DIR, id), { recursive: true, force: true }); } catch (e) {} });
      }
      fireWebhooks('project.deleted', { id, removed: before - reg.projects.length });
      const dep = await requestDeploy('project-delete');
      return json(res, 200, { ok: true, removed: before - reg.projects.length, deploy: dep });
    }
    if (p === '/api/deploy' && req.method === 'POST') {
      const r = await requestDeploy('panel-deploy');
      return json(res, 202, r);
    }
    if (p === '/api/session/start' && req.method === 'POST') {
      const b = await readBody(req);
      const slot = b.slot === 'b' ? 'b' : 'a';
      const cur = state.active || 'a';
      if (slot !== cur && isSessionRunning(cur)) {
        const r = await scheduleHandover('manual-start');
        return json(res, 202, Object.assign({ slot, scheduled: true, note: 'Current session runs until its stop time; new session starts right after.' }, r));
      }
      const r = await startSession(slot, 60000, 'manual-start');
      return json(res, 202, Object.assign({ slot }, r));
    }
    if (p === '/api/session/rotate' && req.method === 'POST') {
      const r = await scheduleHandover('manual-rotate');
      return json(res, 202, Object.assign({ note: 'Safe handover: new session starts after the current stop time.' }, r));
    }
    if (p === '/api/session/refresh' && req.method === 'POST') {
      await tick(true);
      return json(res, 200, publicStatus());
    }
    if (p === '/api/session/pause' && req.method === 'POST') {
      state.enabled = false;
      saveState();
      log('PAUSED by user (running Kaggle session cannot be stopped by API)');
      return json(res, 200, { ok: true, enabled: false, note: 'Auto-rotation paused. The current Kaggle session keeps running; Kaggle stops it at its limit.' });
    }
    if (p === '/api/session/resume' && req.method === 'POST') {
      state.enabled = true;
      saveState();
      log('ENABLED by user');
      tick(true);
      return json(res, 200, { ok: true, enabled: true });
    }
    if (p === '/api/session/logs' && req.method === 'GET') {
      const slot = url.searchParams.get('slot') === 'b' ? 'b' : 'a';
      const r = await runHelper(['logs', SLOT_REF[slot]], 90000);
      return json(res, 200, { ok: true, slot, log: r.error || '' });
    }
    if (p === '/api/backup' && req.method === 'POST') {
      const cur = state.active || 'a';
      if (!isSessionRunning(cur)) {
        const r = await startSession(cur, 60000, 'backup');
        return json(res, r.ok ? 200 : 500, Object.assign({ note: 'Code bundle written into the Kaggle notebook session.' }, r));
      }
      const r = await requestDeploy('backup');
      return json(res, 202, {
        ok: true,
        queued: true,
        nextAt: r.nextAt || slotStop(cur),
        note: 'Backup is embedded in the next safe handover push (quota-safe; no extra running session).',
      });
    }
    if (p === '/api/render/fallback' && req.method === 'POST') {
      const r = await renderFallback('manual');
      return json(res, 200, r);
    }
    if (p === '/api/render/services' && req.method === 'GET') {
      return json(res, 200, await renderServices());
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('HTTP error ' + e.message);
    return json(res, 500, { ok: false, error: e.message });
  }
});

function auth(req) {
  let ok = false;
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (m) {
    const exp = tokens.get(m[1]);
    if (exp && exp >= Date.now()) ok = true;
    else tokens.delete(m[1]);
  }
  const supplied = String(req.headers['x-api-key'] || '');
  if (!ok && supplied) {
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(masterKey()).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;
  }
  if (ok && String(req.url || '').startsWith('/api/')) {
    state.apiRequests = Number(state.apiRequests || 0) + 1;
    if (state.apiRequests % 25 === 0) saveState();
  }
  return ok;
}

process.on('SIGTERM', async () => {
  log('SIGTERM received; stopping runtime');
  try { await stopAllRuntime(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGINT', async () => {
  try { await stopAllRuntime(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
});

bootstrap();
