// decider — decision-model service for fast-browser.
// Any agent POSTs a decision (choice / yes-no / score) and gets an answer from a
// SystemOne-protocol model (Jev, LiquidAI d1, Strands Decider): one forward pass per decision.
// POST /task runs the whole browser loop here: observe → decide → act. The calling agent is
// asked back only for field text, irreversible-click confirmation and checking the end state.

import http from 'node:http';
import {
  mainRequest, parseMain, valueRequest, parseValue, needsIrreversibleCheck, irreversibleRequest,
  parseNoul, fieldOf, recentActions, isSecret, maskFor, secretsOf, InvalidAnswer, TEXT_INSTRUCTIONS, CONFIRM_INSTRUCTIONS,
} from './policy.mjs';
import { Ledger, stateId } from './ledger.mjs';

// ── Config ──────────────────────────────────────────────────────────
const num = (v, d) => (v == null || v === '' || !Number.isFinite(+v)) ? d : +v;

const PORT        = num(process.env.PORT, 9300);
const API_KEY     = process.env.API_KEY || '';
const BROWSER_URL = (process.env.BROWSER_URL || 'http://browser:9222').replace(/\/+$/, '');
const BROWSER_KEY = process.env.BROWSER_KEY || '';
const S1_URL      = process.env.SYSTEMONE_URL || 'https://api.typesafe.ai/v1/systemone';
const S1_MODEL    = process.env.SYSTEMONE_MODEL || 'jev-latest';
const S1_KEY      = process.env.SYSTEMONE_KEY || '';
const MIN_CONF    = num(process.env.CONFIDENCE_MIN, 0.5);
const TIMEOUT_MS  = num(process.env.TIMEOUT_MS, 15000);
const HOSTS       = new Set(['localhost', '127.0.0.1', '::1',
  ...(process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const T0          = Date.now();

class HttpError extends Error {
  constructor(status, message, upstream) { super(message); this.status = status; this.upstream = upstream; }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Injected into the browser page to track SPA route changes
const SPA_TRACKER_SCRIPT = `
  await page.evaluate(() => {
    if (window.__spaTrackerInstalled) return;
    window.__spaTrackerInstalled = true;
    window.__spaRoutes = [];
    const record = (url) => {
      try {
        const u = new URL(url, location.origin);
        const key = u.origin + u.pathname;
        if (!window.__spaRoutes.some(r => r.key === key)) {
          window.__spaRoutes.push({ key, url: u.href, ts: Date.now() });
        }
      } catch {}
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function(...args) {
      origPush.apply(this, args);
      if (args[2]) record(args[2]);
    };
    history.replaceState = function(...args) {
      origReplace.apply(this, args);
      if (args[2]) record(args[2]);
    };
    window.addEventListener('popstate', () => record(location.href));
    window.addEventListener('hashchange', (e) => record(e.newURL || location.href));
  });
`;

// ── Upstream calls ──────────────────────────────────────────────────
async function post(url, body, key, who, ms) {
  let r, text;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    text = await r.text();
  } catch (e) {
    if (e.name === 'TimeoutError') throw new HttpError(504, `${who} timed out after ${ms}ms`);
    throw new HttpError(502, `${who} unreachable: ${e.cause?.code || e.cause?.message || e.message}`);
  }
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const d = data?.error?.message ?? data?.detail?.message ?? data?.message ?? data?.error ?? data?.detail ?? text;
    throw new HttpError(502, `${who} returned ${r.status}: ${(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300)}`, r.status);
  }
  if (!isObj(data)) throw new HttpError(502, `${who} returned a non-JSON body: ${text.slice(0, 200)}`);
  return data;
}

const decide = body =>
  post(S1_URL, { ...body, model: body.model || S1_MODEL }, S1_KEY, 'Decision model', TIMEOUT_MS);

const browser = (path, body) =>
  post(`${BROWSER_URL}${path}`, body, BROWSER_KEY, 'Browser', TIMEOUT_MS + 5000);

// ── Task store and loop ─────────────────────────────────────────────
const tasks = new Map();   // the current task plus a few finished ones for GET /task traces
let current = null, nextId = 1;
const anyBusy = () => [...tasks.values()].find(x => x.busy);

// Approximate registrable domain (no public-suffix list): last two labels, three for ccTLD forms like co.uk
function siteOf(u) {
  let h;
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return null; h = x.hostname.toLowerCase(); } catch { return null; }
  const l = h.split('.');
  if (l.length <= 2 || /^\d+$/.test(l.at(-1)) || h.includes(':')) return h;
  return l.slice(l.at(-1).length === 2 && l.at(-2).length <= 3 ? -3 : -2).join('.');
}

async function model(t, body) {
  for (let i = 0; ; i++) {
    const t0 = Date.now();
    t.stats.model_calls++;
    try {
      const r = await decide(body);
      t.stats.model_ms += Date.now() - t0;
      const u = r.usage || {};
      t.stats.input_tokens += num(u.input_tokens ?? u.prompt_tokens, 0);
      t.stats.output_tokens += num(u.output_tokens ?? u.completion_tokens, 0);
      if (Number.isFinite(u.cost)) t.stats.cost = (t.stats.cost || 0) + u.cost;
      return { r, ms: Date.now() - t0 };
    } catch (e) {
      t.stats.model_ms += Date.now() - t0;
      if (i < 2 && [429, 503, 529].includes(e.upstream)) { await sleep(500 * 2 ** i); continue; }
      throw e;
    }
  }
}

async function observe(t) {
  const r = await browser('/observe', {});
  if (!r.ok) throw new HttpError(502, `Browser observe failed: ${r.error || 'unknown error'}`);
  t.obs = r;
  t.page = { url: r.url, title: r.title };
  t.site ??= siteOf(r.url);
  // Record state in the exploration ledger
  if (t.ledger) {
    const sid = t.ledger.recordState(r);
    t.currentStateId = sid;
    // Record route
    t.ledger.recordRoute(r.url, t.lastUrl || null);
    // Detect forms from fill actions
    const fillActions = (r.actions || []).filter(a => a.kind === 'fill');
    if (fillActions.length > 0 && sid) {
      t.ledger.recordForm(sid, r.url, fillActions);
    }
    t.lastUrl = r.url;
    // Collect SPA-discovered routes from the in-page tracker
    try {
      const spa = await browser('/run', { code: 'return await page.evaluate(() => { const r = window.__spaRoutes || []; window.__spaRoutes = []; return r; })', timeout_ms: 3000 });
      if (spa.ok && Array.isArray(spa.result)) {
        for (const route of spa.result) {
          if (route.url) t.ledger.recordRoute(route.url, 'spa');
        }
      }
    } catch { /* SPA collection is best-effort */ }
  }
  return r;
}

async function choose(t) {
  const req = mainRequest(t.obs, t.goal, t.history, S1_MODEL, secretsOf(t.values), t.ledger);
  const { r, ms } = await model(t, req.body);
  t.stats.decisions++;
  const rec = { n: t.stats.decisions, operation: null, target: null, latency_ms: ms, usage: r.usage || {} };
  t.decisions.push(rec);
  let d;
  try { d = parseMain(r, req); } catch (e) { rec.error = e.message; throw e; }
  Object.assign(rec, { operation: d.operation, target: d.target, element: d.element, top: d.top, confidence: d.confidence });
  if (d.operation_top) rec.operation_top = d.operation_top;
  return { ...d, obs: t.obs, started: Date.now() - ms };
}

const fieldKey = a => `${a.node}|${a.label}`;

const ctx = t => ({
  goal: t.goal,
  page: { url: t.obs?.url ?? t.page?.url, title: t.obs?.title ?? t.page?.title, text: (t.obs?.text || '').slice(0, 2000) },
  recent_actions: recentActions(t.history, secretsOf(t.values)),
});

// Cached text and confirmation only serve the stale retry of the same element
function forgetUnless(t, a) {
  const key = a ? fieldKey(a) : null;
  if (t.confirmed && t.confirmed !== key) t.confirmed = null;
  if (t.textCache && t.textCache.key !== key) t.textCache = null;
}

function stop(t, status, reason, resumable) {
  t.status = status;
  t.reason = reason;
  t.resumable = resumable;
  t.pending = null;
  if (status === 'blocked' || status === 'done' || status === 'error') t.decision = null;
}

function pause(t, kind, d, extra) {
  t.status = kind === 'text' ? 'needs_text' : 'needs_confirmation';
  t.reason = undefined;
  t.resumable = true;
  t.pending = {
    kind, ...extra, context: ctx(t),
    instructions: (kind === 'text' ? TEXT_INSTRUCTIONS : CONFIRM_INSTRUCTIONS).replace('<id>', t.id),
  };
}

// Budgets count per call, so {max_actions: 1} plus /task/continue steps one action at a time
async function loop(t, deadline, steps) {
  const base = { actions: t.stats.actions, decisions: t.stats.decisions };
  for (;;) {
    if (t.stopRequested) { t.stopRequested = false; return stop(t, 'blocked', 'stopped by agent', true); }
    if (!t.obs) await observe(t);
    let d = t.decision;
    if (!d) {
      if (t.stats.actions - base.actions >= t.max_actions)
        return stop(t, 'blocked', `reached max_actions (${t.max_actions}) for this call; continue to keep going`, true);
      if (t.stats.decisions - base.decisions >= t.max_decisions)
        return stop(t, 'blocked', `reached max_decisions (${t.max_decisions}) for this call; continue to keep going`, true);
      if (Date.now() >= deadline) return stop(t, 'running', 'max_ms reached; continue to keep going', true);
      d = t.decision = await choose(t);
      forgetUnless(t, d.action);
    }

    if (d.operation === 'DONE' || d.operation === 'BLOCKED') {
      t.decision = null;
      const before = d.obs.marker;
      await observe(t);
      if (t.obs.marker !== before) continue;
      if (d.operation === 'DONE') {
        // Enhanced completion: check frontier before accepting DONE
        if (t.ledger) {
          const pending = [...t.ledger.frontier.values()].filter(f => f.status === 'pending');
          if (pending.length > 0) {
            // Model said DONE but frontier has unexplored routes — override to continue
            return stop(t, 'blocked',
              `decision model chose DONE but ${pending.length} frontier route(s) remain unexplored; continue to explore them`, true);
          }
        }
        return stop(t, 'done', 'decision model chose DONE; verify the final page', false);
      }
      return stop(t, 'blocked', 'decision model chose BLOCKED: no supported operation can progress', true);
    }

    const a = d.action;
    const secrets = secretsOf(t.values);
    let text;
    if (a.kind === 'fill') {
      const key = fieldKey(a);
      if (t.textCache?.key === key) text = t.textCache.text;
      else {
        // Values belong to the site the task started on; elsewhere the agent decides what to type
        const have = Object.keys(t.values).length > 0, foreign = !!t.site && siteOf(d.obs.url) !== t.site;
        if (have && !foreign) {
          const { r } = await model(t, valueRequest(t.goal, a, d.obs, t.history, t.values, S1_MODEL, secrets));
          const v = parseValue(r, t.values);
          if (v.name !== 'ask_agent' && v.confidence >= MIN_CONF) text = t.values[v.name];
        }
        if (text == null) return pause(t, 'text', d, {
          field: fieldOf(d.target, a, secrets),
          ...(have && foreign ? { note: `This page is not on ${t.site}, where the task started; supplied values are not filled in automatically here.` } : {}),
        });
        t.textCache = { key, text };
      }
    } else if (a.kind === 'click' && t.confirm && needsIrreversibleCheck(a, d.obs) && t.confirmed !== fieldKey(a)) {
      const { r } = await model(t, irreversibleRequest(t.goal, d.element, d.obs, t.history, S1_MODEL, secrets));
      const p = parseNoul(r);
      if (p >= 0.5) return pause(t, 'confirm', d, { element: d.element, p_irreversible: p });
    }

    t.decision = null;
    let res;
    try {
      res = await browser('/act', { obs: d.obs.obs, action: a.id, ...(text != null ? { text } : {}) });
    } catch (e) {
      if (e.upstream && e.upstream < 500) throw e;
      res = { ok: false, unknown: true, error: e.message };
    }
    if (res.stale) {
      if (t.ledger) t.ledger.recordAction(d.operation, d.element, t.currentStateId, 'stale', { detail: 'observation expired' });
      await observe(t);
      continue;
    }
    t.confirmed = null;
    const secret = text != null && (isSecret(a.label) || secrets.has(text));
    const step = {
      n: t.history.length + 1, op: d.operation, target: d.element,
      ...(text != null ? { text: secret ? '***' : text } : {}),
      p: d.p, ms: Date.now() - d.started, changed: null,
    };
    // Record execution before observing: a failed observation must not erase the action
    const h = { action: a.label, kind: a.kind, field: a.label, text: text ?? null, secret, page_changed: null };
    if (res.unknown || !res.ok) {
      t.history.push(h);
      steps.push(step);
      t.stats.actions++;
      if (t.ledger) t.ledger.recordAction(d.operation, d.element, t.currentStateId, 'unknown', { ms: step.ms, detail: res.error });
      t.obs = null;
      return stop(t, 'blocked', 'outcome unknown — inspect the page, then continue', true);
    }
    t.history.push(h);
    steps.push(step);
    t.stats.actions++;
    if (a.kind === 'fill') t.textCache = null;
    const fp = d.obs.fingerprint;
    t.obs = null;
    await observe(t);
    h.page_changed = step.changed = t.obs.fingerprint !== fp;

    // Postcondition verification and retry tracking
    if (t.ledger) {
      let outcome = 'pending';
      let detail = null;

      if (a.kind === 'click' && a.role === 'link' && a.href) {
        outcome = h.page_changed ? 'success' : 'failed';
        if (!h.page_changed) detail = 'navigation click did not change page';
      } else if (a.kind === 'fill' && text != null) {
        outcome = 'success';
      } else if (h.page_changed) {
        outcome = 'success';
      }

      t.ledger.recordAction(d.operation, d.element, t.currentStateId, outcome, {
        ms: step.ms, pageChanged: h.page_changed, detail,
      });
      if (t.ledger.subgoal) t.ledger.subgoal.actionsInSubgoal++;

      // Bounded retry: if same target fails 3+ times at same state, skip it
      const retryInfo = t.ledger.getRetryInfo(t.currentStateId, d.element);
      if (retryInfo.attempts >= 3 && outcome === 'failed') {
        t.ledger.recordAction(d.operation, d.element, t.currentStateId, 'blocked', {
          detail: `abandoned after ${retryInfo.attempts} attempts`,
        });
      }
    }

    const last = t.history.slice(-3);
    if (last.length === 3 && last.every(x => x.page_changed === false && x.kind !== 'wait'))
      return stop(t, 'blocked', 'no progress: the last 3 actions did not change the page', true);
  }
}

function response(t, steps) {
  const out = { ok: true, task: t.id, status: t.status };
  if (t.reason) out.reason = t.reason;
  if (t.resumable != null && t.status !== 'needs_text' && t.status !== 'needs_confirmation') out.resumable = t.resumable;
  out.steps = steps;
  if (t.pending) out.pending = t.pending;
  out.page = { url: t.obs?.url ?? t.page?.url ?? null, title: t.obs?.title ?? t.page?.title ?? null };
  if ((t.status === 'done' || t.status === 'blocked') && t.obs)
    out.final = { url: t.obs.url, title: t.obs.title, text: (t.obs.text || '').slice(0, 2000) };
  out.stats = { ...t.stats };
  // Include exploration progress from the ledger
  if (t.ledger) {
    out.exploration = t.ledger.completionStatus();
    if (t.ledger.subgoal) out.subgoal = { text: t.ledger.subgoal.text, actions: t.ledger.subgoal.actionsInSubgoal };
  }
  return out;
}

async function runCall(t, maxMs) {
  const start = Date.now(), steps = [];
  t.busy = true;
  t.status = 'running';
  t.pending = null;
  try {
    await loop(t, start + maxMs, steps);
  } catch (e) {
    t.decision = null;
    t.obs = null;
    stop(t, 'error', e instanceof InvalidAnswer || e instanceof HttpError ? e.message : `Internal error: ${e.message}`, true);
  } finally {
    t.busy = false;
    // A stop that arrived after the loop's last check is satisfied by this call ending
    t.stopRequested = false;
    t.stats.elapsed_ms += Date.now() - start;
  }
  return response(t, steps);
}

// ── Input validation ────────────────────────────────────────────────
function intField(body, k, d, max) {
  const v = body[k];
  if (v == null) return d;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new HttpError(400, `${k} must be an integer from 1 to ${max}`);
  return v;
}

function valuesField(v) {
  if (v == null) return {};
  if (!isObj(v)) throw new HttpError(400, 'values must be an object of name → string');
  const out = {};
  for (const [k, s] of Object.entries(v)) {
    if (!k.trim() || k.length > 100 || k === 'ask_agent' || k === '__proto__')
      throw new HttpError(400, `Invalid value name ${JSON.stringify(k)}`);
    if (typeof s !== 'string' || s.length > 2000) throw new HttpError(400, `values.${k} must be a string of at most 2000 characters`);
    out[k] = s;
  }
  if (Object.keys(out).length > 50) throw new HttpError(400, 'At most 50 values');
  return out;
}

function getTask(id) {
  const t = typeof id === 'string' && tasks.get(id);
  if (!t) throw new HttpError(404, `Unknown task ${JSON.stringify(id ?? null)}`);
  return t;
}

async function startTask(body) {
  const busyTask = anyBusy();
  if (busyTask) throw new HttpError(409, `A call for task ${busyTask.id} is in flight`);
  const goal = body.goal;
  if (typeof goal !== 'string' || !goal.trim()) throw new HttpError(400, 'Missing required field: goal');
  if (goal.length > 4000) throw new HttpError(400, 'goal is longer than 4000 characters');
  if (body.url != null && (typeof body.url !== 'string' || !body.url.trim())) throw new HttpError(400, 'url must be a string');
  if (body.confirm != null && typeof body.confirm !== 'boolean') throw new HttpError(400, 'confirm must be a boolean');
  const values = valuesField(body.values);
  const t = {
    id: `t${nextId++}`, goal: goal.trim(), values, confirm: body.confirm !== false,
    max_actions: intField(body, 'max_actions', 60, 1000),
    max_decisions: intField(body, 'max_decisions', 120, 2000),
    status: 'running', reason: undefined, resumable: undefined, pending: null, busy: true,
    obs: null, page: null, site: null, decision: null, history: [], decisions: [], textCache: null, confirmed: null,
    currentStateId: null, lastUrl: null,
    stats: { actions: 0, decisions: 0, model_calls: 0, elapsed_ms: 0, model_ms: 0, input_tokens: 0, output_tokens: 0 },
  };
  t.ledger = new Ledger(t.id, goal.trim(), body.role || null);
  if (body.subgoal) t.ledger.setSubgoal(body.subgoal, body.expected_outcome || null);
  const maxMs = intField(body, 'max_ms', 60000, 600000);
  current = t;
  tasks.set(t.id, t);
  for (const id of tasks.keys()) if (tasks.size > 5 && id !== t.id) tasks.delete(id);
  // The initial navigation runs outside the task clock
  if (body.url != null) {
    let r;
    try {
      r = await post(`${BROWSER_URL}/run`, { code: `await goto(${JSON.stringify(body.url)})`, timeout_ms: TIMEOUT_MS },
        BROWSER_KEY, 'Browser', TIMEOUT_MS + 5000);
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      t.busy = false;
      stop(t, 'error', `Opening ${body.url} failed: ${r.error || 'unknown error'}`, true);
      return response(t, []);
    }
  }
  // Install SPA route tracker before exploration begins
  try {
    await post(`${BROWSER_URL}/run`, { code: SPA_TRACKER_SCRIPT, timeout_ms: 5000 }, BROWSER_KEY, 'Browser', 10000);
  } catch { /* non-fatal — SPA tracking is best-effort */ }
  return runCall(t, maxMs);
}

async function continueTask(body) {
  const t = getTask(body.task);
  // One browser, one active task: a replaced task stays readable via GET /task but never runs again
  const busyTask = anyBusy();
  if (busyTask) throw new HttpError(409, `A call for task ${busyTask.id} is in flight`);
  if (t !== current) throw new HttpError(409, `Task ${t.id} was replaced by ${current?.id}; start a new task`);
  if (t.status === 'done') throw new HttpError(400, `Task ${t.id} is done; start a new task`);
  if (t.status === 'error' && !t.resumable) throw new HttpError(400, `Task ${t.id} cannot be continued`);
  const values = valuesField(body.values);
  const maxMs = intField(body, 'max_ms', 60000, 600000);
  t.max_actions = intField(body, 'max_actions', t.max_actions, 1000);
  t.max_decisions = intField(body, 'max_decisions', t.max_decisions, 2000);
  let answer = null;
  if (t.status === 'needs_text') {
    if (!Object.hasOwn(body, 'text')) throw new HttpError(400, 'This task needs text: send text (string) or text: null');
    const tx = body.text;
    if (tx !== null && (typeof tx !== 'string' || !tx.length || tx.length > 2000))
      throw new HttpError(400, 'text must be a non-empty string of at most 2000 characters, or null');
    answer = () => {
      const a = t.decision.action;
      if (tx === null) return stop(t, 'blocked', `no value for the field ${JSON.stringify(a.label)}`, true), false;
      t.values[a.label] = tx;
      t.textCache = { key: fieldKey(a), text: tx };
      t.decision.started = Date.now();
      return true;
    };
  } else if (t.status === 'needs_confirmation') {
    if (typeof body.confirm !== 'boolean') throw new HttpError(400, 'This task needs confirm: true or false');
    answer = () => {
      if (!body.confirm) return stop(t, 'blocked', `declined: ${t.decision.element}`, true), false;
      t.confirmed = fieldKey(t.decision.action);
      t.decision.started = Date.now();
      return true;
    };
  } else if (body.confirm != null && typeof body.confirm !== 'boolean') {
    throw new HttpError(400, 'confirm must be a boolean');
  }
  Object.assign(t.values, values);
  // Update subgoal if provided
  if (body.subgoal !== undefined && t.ledger) {
    t.ledger.setSubgoal(body.subgoal || null, body.expected_outcome || null);
  }
  if (answer) {
    if (!answer()) { t.obs = null; return response(t, []); }
  } else {
    // The agent may have changed the page while the task was idle
    t.decision = null;
    t.obs = null;
    t.confirmed = null;
    t.textCache = null;
  }
  return runCall(t, maxMs);
}

function stopTask(body) {
  const t = getTask(body.task);
  if (t.busy) { t.stopRequested = true; return { ...response(t, []), stopping: true }; }
  if (t.status !== 'done') stop(t, 'blocked', 'stopped by agent', true);
  return response(t, []);
}

function trace(id) {
  const t = getTask(id);
  const out = {
    ok: true, task: t.id, goal: t.goal, status: t.status, ...(t.reason ? { reason: t.reason } : {}),
    decisions: t.decisions,
    actions: t.history.map((h, i) => ({ n: i + 1, action: h.action, kind: h.kind,
      text: h.text == null ? null : h.secret ? '***' : maskFor(h.field, h.text, secretsOf(t.values)), page_changed: h.page_changed })),
    stats: response(t, []).stats,
  };
  if (t.ledger) out.exploration = t.ledger.toJSON();
  return out;
}

// ── HTTP server ─────────────────────────────────────────────────────
function readBody(req, max = 10e6) {
  return new Promise((ok, no) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n <= max) chunks.push(c); });
    req.on('end', () => n > max ? no(new HttpError(413, 'Body too large')) : ok(Buffer.concat(chunks).toString()));
    req.on('error', no);
  });
}

function jsonRes(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

const hostAllowed = h => HOSTS.has(h.toLowerCase().replace(/^\[|\]$/g, ''));

// Blocks DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host/Origin
function checkHost(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch {}
  if (!req.headers.host || !host || !hostAllowed(host)) throw new HttpError(403, 'Forbidden host');
  const origin = req.headers.origin;
  if (origin != null) {
    let u;
    try { u = new URL(origin); } catch {}
    if (!u || !/^https?:$/.test(u.protocol) || !hostAllowed(u.hostname)) throw new HttpError(403, 'Forbidden origin');
  }
}

const ENDPOINTS = 'GET /health, POST /decide, POST /task, POST /task/continue, POST /task/stop, GET /task?id=';
const POSTS = new Set(['/decide', '/task', '/task/continue', '/task/stop']);

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const [path, query = ''] = (req.url || '').split('?');
  let status = 200, out;
  try {
    checkHost(req);
    if (path === '/health' && req.method === 'GET') {
      out = {
        ok: true, model: S1_MODEL, systemone_url: S1_URL, key_set: !!S1_KEY, browser_url: BROWSER_URL,
        confidence_min: MIN_CONF, uptime_s: Math.round((Date.now() - T0) / 1000),
      };
    } else if (path === '/task' && req.method === 'GET') {
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) throw new HttpError(401, 'Unauthorized');
      out = trace(new URLSearchParams(query).get('id'));
    } else if (req.method === 'POST' && POSTS.has(path)) {
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) throw new HttpError(401, 'Unauthorized');
      // JSON-only forces a CORS preflight, which is never granted, so web pages can't drive this server
      if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
        throw new HttpError(415, 'Content-Type must be application/json');
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'Invalid JSON body'); }
      if (!isObj(body)) throw new HttpError(400, 'Body must be a JSON object');
      if (path === '/decide') {
        if (!isObj(body.questions) || !Object.keys(body.questions).length) throw new HttpError(400, 'Missing required field: questions');
        out = { ok: true, ...(await decide(body)) };
      } else if (path === '/task') out = await startTask(body);
      else if (path === '/task/continue') out = await continueTask(body);
      else out = stopTask(body);
    } else {
      throw new HttpError(404, `Not found. Endpoints: ${ENDPOINTS}`);
    }
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    out = { ok: false, error: e.message, ...(e.upstream ? { upstream_status: e.upstream } : {}) };
  }
  out.elapsed_ms = Date.now() - t0;
  jsonRes(res, status, out);
  process.stderr.write(`${req.method} ${path} ${status} ${out.elapsed_ms}ms` +
    (out.task ? ` task=${out.task} status=${out.status} steps=${out.steps?.length ?? '-'}` : '') + '\n');
});

server.listen(PORT, () => {
  process.stderr.write(`decider :${PORT}  model=${S1_MODEL}  systemone=${S1_URL}  browser=${BROWSER_URL}\n`);
  if (!S1_KEY && S1_URL.startsWith('https:'))
    process.stderr.write('warning: SYSTEMONE_KEY is not set; hosted decision APIs will reject requests\n');
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
