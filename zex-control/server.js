#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PANEL = path.join(ROOT, '..', 'kangle.html');
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
      return Object.assign({}, p, { files });
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
      note: 'Quota-safe mode: only one session runs projects. Each worker self-stops at its 12h limit; the next session is prepared in advance with a start time after the old stop, so there is no duplicate execution.',
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
    worker: ['main.py', 'worker.py', 'app.py', 'run.py', 'index.py'],
  }[p.kind] || ['main.py', 'app.py', 'bot.py', 'worker.py', 'run.py', 'index.py'];
  const py = find(pyPreferred);
  if (py) return 'python3 -u ' + py;
  const nodePreferred = {
    discord_bot: ['index.js', 'bot.js', 'main.js', 'server.js'],
    telegram_bot: ['index.js', 'bot.js', 'main.js', 'server.js'],
    api: ['server.js', 'index.js', 'app.js', 'main.js'],
    worker: ['index.js', 'worker.js', 'main.js', 'server.js'],
  }[p.kind] || ['index.js', 'server.js', 'app.js', 'main.js'];
  const node = find(nodePreferred);
  if (node) return 'node ' + node;
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
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(PANEL, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
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
    if (!auth(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/status') {
      return json(res, 200, publicStatus());
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
      log('PROJECT deleted: ' + id + ' (' + (before - reg.projects.length) + ')');
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

bootstrap();
