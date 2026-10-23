// Exploration ledger — task-scoped memory for the decider.
// Tracks discovered states, routes, endpoints, forms, and action outcomes.
// Survives task pauses/continuations. Secrets are never stored.

import { createHash } from 'node:crypto';

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 12);

// State identity: meaningful UI state, not pixel-level fingerprint.
// Combines origin+route+semantic signals so cosmetic changes don't create new states
// but distinct dialogs/tabs at the same URL remain distinguishable.
export function stateId(obs) {
  if (!obs?.url) return null;
  let u;
  try { u = new URL(obs.url); } catch { return null; }

  // Semantic signals from the page: dialogs, tabs, visible form count
  const actions = obs.actions || [];
  const dialogOpen = actions.some(a =>
    a.role === 'button' && /close|cancel|dismiss/i.test(a.label));
  const selectedTab = actions.find(a =>
    a.role === 'tab' && a.selected === 'true');
  const formFields = actions.filter(a => a.kind === 'fill').length;
  const hasSelect = actions.some(a => a.kind === 'select');

  const parts = [
    u.origin,
    u.pathname,
    u.search || '',
    u.hash || '',
    dialogOpen ? 'dialog' : '',
    selectedTab ? `tab:${selectedTab.label}` : '',
    formFields > 0 ? `fields:${formFields}` : '',
    hasSelect ? 'selects' : '',
  ].filter(Boolean);

  return sha(parts.join('|'));
}

// Normalize a URL to origin+pathname for route comparison
function routeKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch { return urlStr; }
}

export class Ledger {
  constructor(taskId, goal, role) {
    this.taskId = taskId;
    this.goal = goal;
    this.role = role || null;
    this.createdAt = Date.now();

    // Discovered states: stateId → {url, title, visitCount, firstSeen, lastSeen, semantic}
    this.states = new Map();
    // Routes: normalized route → {url, discoveredFrom, visited, firstSeen}
    this.routes = new Map();
    // Endpoints observed in network traffic: "METHOD path" → {method, path, count, firstSeen, sources}
    this.endpoints = new Map();
    // Forms: stateId+formKey → {fields[], stateId, url, inspected, submitted}
    this.forms = new Map();
    // Action log: [{n, op, target, stateId, outcome, attemptN, ms, ts}]
    this.actions = [];
    // Frontier: routes/states discovered but not yet fully explored
    this.frontier = new Map(); // routeKey → {url, source, priority, status: 'pending'|'visited'|'blocked'}
    // Subgoal tracking
    this.subgoal = null;
    this.subgoalHistory = [];

    // Retry tracking per target: "stateId|actionLabel" → {attempts, lastOutcome, lastStrategy}
    this.retries = new Map();
  }

  // Record visiting a state (from an observation)
  recordState(obs) {
    const sid = stateId(obs);
    if (!sid) return null;
    const now = Date.now();
    const existing = this.states.get(sid);
    if (existing) {
      existing.visitCount++;
      existing.lastSeen = now;
      return sid;
    }
    this.states.set(sid, {
      url: obs.url,
      title: obs.title,
      visitCount: 1,
      firstSeen: now,
      lastSeen: now,
      actionCount: (obs.actions || []).length,
      fillableFields: (obs.actions || []).filter(a => a.kind === 'fill').length,
    });

    // Mark this route as visited in frontier
    const rk = routeKey(obs.url);
    const fr = this.frontier.get(rk);
    if (fr) fr.status = 'visited';

    return sid;
  }

  // Record a discovered route (from navigation, links, SPA events)
  recordRoute(url, source) {
    const rk = routeKey(url);
    if (this.routes.has(rk)) return false;
    this.routes.set(rk, {
      url,
      discoveredFrom: source || null,
      visited: false,
      firstSeen: Date.now(),
    });
    // Add to frontier if not already visited
    if (!this.frontier.has(rk)) {
      this.frontier.set(rk, {
        url,
        source: source || null,
        priority: 'normal',
        status: 'pending',
      });
    }
    return true;
  }

  // Record a network endpoint observation
  recordEndpoint(method, path, source) {
    const key = `${method} ${path}`;
    const existing = this.endpoints.get(key);
    if (existing) {
      existing.count++;
      if (source && !existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      return false;
    }
    this.endpoints.set(key, {
      method,
      path,
      count: 1,
      firstSeen: Date.now(),
      sources: source ? [source] : [],
    });
    return true;
  }

  // Record a form discovery
  recordForm(sid, url, fields) {
    const key = `${sid}|${fields.map(f => f.label).sort().join(',')}`;
    if (this.forms.has(key)) return false;
    this.forms.set(key, {
      stateId: sid,
      url,
      fields: fields.map(f => ({ label: f.label, role: f.role, kind: f.kind })),
      inspected: true,
      submitted: false,
      discoveredAt: Date.now(),
    });
    return true;
  }

  // Record an action and its outcome
  recordAction(op, target, sid, outcome, extra = {}) {
    const retryKey = `${sid}|${target}`;
    const retryInfo = this.retries.get(retryKey) || { attempts: 0, lastOutcome: null, lastStrategy: null };
    retryInfo.attempts++;
    retryInfo.lastOutcome = outcome;
    this.retries.set(retryKey, retryInfo);

    const entry = {
      n: this.actions.length + 1,
      op,
      target,
      stateId: sid,
      outcome, // 'success' | 'failed' | 'stale' | 'pending' | 'unknown' | 'blocked'
      attemptN: retryInfo.attempts,
      ms: extra.ms || 0,
      ts: Date.now(),
      pageChanged: extra.pageChanged ?? null,
      ...extra.detail ? { detail: extra.detail } : {},
    };
    this.actions.push(entry);
    return entry;
  }

  // Set current subgoal
  setSubgoal(subgoal, expectedOutcome) {
    if (this.subgoal) {
      this.subgoalHistory.push({ ...this.subgoal, endedAt: Date.now() });
    }
    this.subgoal = subgoal ? {
      text: subgoal,
      expectedOutcome: expectedOutcome || null,
      startedAt: Date.now(),
      actionsInSubgoal: 0,
    } : null;
  }

  // Mark frontier item
  markFrontier(url, status) {
    const rk = routeKey(url);
    const fr = this.frontier.get(rk);
    if (fr) fr.status = status;
  }

  // Get retry info for a specific target at a state
  getRetryInfo(sid, target) {
    return this.retries.get(`${sid}|${target}`) || { attempts: 0, lastOutcome: null };
  }

  // Build a bounded context summary for the decision model
  contextSummary(maxItems = 15) {
    const summary = {
      goal: this.goal,
      subgoal: this.subgoal?.text || null,
      expectedOutcome: this.subgoal?.expectedOutcome || null,
    };

    // States explored (count, not full list)
    summary.statesExplored = this.states.size;
    summary.routesDiscovered = this.routes.size;
    summary.endpointsObserved = this.endpoints.size;
    summary.formsFound = this.forms.size;

    // Recent actions with outcomes (more useful than raw history)
    summary.recentActions = this.actions.slice(-maxItems).map(a => ({
      op: a.op,
      target: a.target,
      outcome: a.outcome,
      attemptN: a.attemptN > 1 ? a.attemptN : undefined,
      pageChanged: a.pageChanged,
    }));

    // Pending frontier work
    const pending = [...this.frontier.values()].filter(f => f.status === 'pending');
    summary.pendingFrontier = pending.length;
    summary.pendingRoutes = pending.slice(0, 5).map(f => f.url);

    // Recent failures (for retry context)
    const recentFails = this.actions.filter(a =>
      a.outcome === 'failed' || a.outcome === 'unknown' || a.outcome === 'blocked'
    ).slice(-5);
    if (recentFails.length > 0) {
      summary.recentFailures = recentFails.map(f => ({
        op: f.op,
        target: f.target,
        outcome: f.outcome,
        attemptN: f.attemptN,
        detail: f.detail,
      }));
    }

    return summary;
  }

  // Completion assessment — what's done and what remains
  completionStatus() {
    const totalRoutes = this.routes.size;
    const visitedRoutes = [...this.routes.values()].filter(r => r.visited).length;
    const pendingFrontier = [...this.frontier.values()].filter(f => f.status === 'pending').length;
    const blockedFrontier = [...this.frontier.values()].filter(f => f.status === 'blocked').length;
    const formsInspected = [...this.forms.values()].filter(f => f.inspected).length;
    const totalActions = this.actions.length;
    const successfulActions = this.actions.filter(a => a.outcome === 'success').length;
    const failedActions = this.actions.filter(a => a.outcome === 'failed').length;
    const unknownActions = this.actions.filter(a => a.outcome === 'unknown').length;

    return {
      states: { explored: this.states.size },
      routes: { discovered: totalRoutes, visited: visitedRoutes, pending: totalRoutes - visitedRoutes },
      endpoints: { observed: this.endpoints.size },
      forms: { found: this.forms.size, inspected: formsInspected },
      frontier: { pending: pendingFrontier, blocked: blockedFrontier },
      actions: { total: totalActions, successful: successfulActions, failed: failedActions, unknown: unknownActions },
      subgoals: { completed: this.subgoalHistory.length, current: this.subgoal?.text || null },
    };
  }

  // Serialize for task pause/continue (no secrets)
  toJSON() {
    return {
      taskId: this.taskId,
      goal: this.goal,
      role: this.role,
      createdAt: this.createdAt,
      states: Object.fromEntries(this.states),
      routes: Object.fromEntries(this.routes),
      endpoints: Object.fromEntries(this.endpoints),
      forms: Object.fromEntries(this.forms),
      actions: this.actions,
      frontier: Object.fromEntries(this.frontier),
      subgoal: this.subgoal,
      subgoalHistory: this.subgoalHistory,
      retries: Object.fromEntries(this.retries),
    };
  }

  // Restore from serialized form
  static fromJSON(data) {
    const l = new Ledger(data.taskId, data.goal, data.role);
    l.createdAt = data.createdAt;
    l.states = new Map(Object.entries(data.states || {}));
    l.routes = new Map(Object.entries(data.routes || {}));
    l.endpoints = new Map(Object.entries(data.endpoints || {}));
    l.forms = new Map(Object.entries(data.forms || {}));
    l.actions = data.actions || [];
    l.frontier = new Map(Object.entries(data.frontier || {}));
    l.subgoal = data.subgoal || null;
    l.subgoalHistory = data.subgoalHistory || [];
    l.retries = new Map(Object.entries(data.retries || {}));
    return l;
  }
}
