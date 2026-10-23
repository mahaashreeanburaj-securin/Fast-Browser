#!/usr/bin/env node
// MCP bridge: exposes Fast-Browser HTTP API as MCP tools over stdio.
// Implements MCP protocol (JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout).

import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';

const BROWSER_URL = process.env.FAST_BROWSER_URL || 'http://localhost:9222';
const DECIDER_URL = process.env.FAST_DECIDER_URL || 'http://localhost:9300';

// --- HTTP helpers ---

async function post(base, path, body, opts = {}) {
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
  });
  return resp.json();
}

async function get(base, path) {
  const resp = await fetch(`${base}${path}`);
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('json')) return resp.json();
  return { ok: true, data: await resp.text() };
}

async function getBinary(base, path) {
  const resp = await fetch(`${base}${path}`);
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
  const buf = Buffer.from(await resp.arrayBuffer());
  return { ok: true, size: buf.length, base64: buf.toString('base64') };
}

async function postBinary(base, path, base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: buf,
  });
  return resp.json();
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'fb_health',
    description: 'Check Fast-Browser health status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_navigate',
    description: 'Navigate to a URL. Returns status, title, and final URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_run',
    description: 'Execute batched Playwright JavaScript in the browser. Helpers available: goto, snap, text, html, click, fill, type, select, press, scroll, wait, shot, cookies, setCookie, store, etc. Single expressions auto-return. Use for login flows (bypasses observe.js password filtering), complex multi-step interactions, and data extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute (async/await supported)' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 30000)' },
        max_output: { type: 'number', description: 'Max output chars (default 8000)' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_observe',
    description: 'Read the visible viewport: text (up to 6000 chars), scroll position, and every on-screen interactive element as an action. Password/file/hidden inputs are excluded. Returns action IDs for use with fb_act.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_act',
    description: 'Execute one action from an fb_observe result. The action must still be unchanged on the page. For fill actions, provide text.',
    inputSchema: {
      type: 'object',
      properties: {
        obs: { type: 'string', description: 'Observation ID from fb_observe (e.g. "o12")' },
        action: { type: 'string', description: 'Action ID (e.g. "e3", "scroll_down", "wait")' },
        text: { type: 'string', description: 'Text for fill actions' },
      },
      required: ['obs', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_screenshot',
    description: 'Take a JPEG screenshot of the current page. Returns base64-encoded image.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Full page screenshot (default false)' },
        selector: { type: 'string', description: 'CSS selector to screenshot' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fb_task',
    description: 'Run an autonomous goal-driven browser task using the Decider (Jev decision model). The Decider handles observe→decide→act at ~100-500ms/step. Returns when done, blocked, or needs agent input (text/confirmation). Includes exploration ledger tracking states, routes, forms, and action outcomes. Use for bulk exploration of unfamiliar pages.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What to do, in plain words' },
        url: { type: 'string', description: 'URL to open before starting (optional)' },
        subgoal: { type: 'string', description: 'Current subgoal for focused exploration (optional)' },
        expected_outcome: { type: 'string', description: 'What success looks like for the subgoal (optional)' },
        role: { type: 'string', description: 'User role being crawled, e.g. "admin", "guest" (optional)' },
        values: { type: 'object', description: 'Known text values as {name: string} for the model to match to fields', additionalProperties: { type: 'string' } },
        confirm: { type: 'boolean', description: 'Pause before irreversible clicks (default true)' },
        max_actions: { type: 'number', description: 'Max browser actions per call (default 60)' },
        max_ms: { type: 'number', description: 'Time limit in ms (default 60000)' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_task_continue',
    description: 'Continue a paused task: provide text for needs_text, confirm for needs_confirmation, or just resume a blocked/running task. Can update the subgoal mid-task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task ID (e.g. "t1")' },
        text: { type: 'string', description: 'Text to type (for needs_text status)' },
        confirm: { type: 'boolean', description: 'Confirm or decline click (for needs_confirmation status)' },
        subgoal: { type: 'string', description: 'Update the current subgoal (optional)' },
        expected_outcome: { type: 'string', description: 'Update expected outcome for the subgoal (optional)' },
        values: { type: 'object', description: 'Additional values to merge', additionalProperties: { type: 'string' } },
        max_ms: { type: 'number', description: 'Time limit for this continuation' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_task_stop',
    description: 'Stop an active task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task ID to stop' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_task_trace',
    description: 'Get the full trace of a task: every decision with probabilities, confidence, latency, and tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_decide',
    description: 'Make a decision using the Jev model. Not tied to the browser — general-purpose choice/yes-no/score. Multiple questions per call.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Situation description' },
        questions: { type: 'object', description: 'Named questions: {name: {type: "choice"|"noul"|"score", instructions: string, criteria: ...}}' },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_profile_info',
    description: 'Get browser profile info: cookie count, logged-in domains, profile size.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_profile_snapshot',
    description: 'Export the current browser profile as a tar.gz snapshot (base64). Use to save authenticated sessions for role switching.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_profile_load',
    description: 'Import a tar.gz profile snapshot (base64). Browser restarts with the imported profile. Use to restore authenticated sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_base64: { type: 'string', description: 'Base64-encoded tar.gz profile snapshot' },
      },
      required: ['snapshot_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'fb_profile_reset',
    description: 'Wipe browser profile and restart with a clean state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_view_url',
    description: 'Get the live browser viewer URL. The operator can open this to see the browser, click, type, and interact directly. Useful for login, CAPTCHAs, and debugging.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_state',
    description: 'Get lightweight browser state: current URL, tabs, busy status, last action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_screenshots_save',
    description: 'Capture and save a screenshot to the gallery.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_screenshots_list',
    description: 'List all saved screenshots in the gallery.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fb_net',
    description: 'Get recent network requests from the browser. Useful for observing API calls made by the application.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of recent requests (default 20)' },
        filter: { type: 'string', description: 'URL filter pattern' },
      },
      additionalProperties: false,
    },
  },
];

// --- Tool execution ---

async function executeTool(name, args) {
  try {
    switch (name) {
      case 'fb_health':
        return await get(BROWSER_URL, '/health');

      case 'fb_navigate':
        return await post(BROWSER_URL, '/run', {
          code: `await goto(${JSON.stringify(args.url)}); return { url: url(), title: title() }`,
        });

      case 'fb_run':
        return await post(BROWSER_URL, '/run', {
          code: args.code,
          timeout_ms: args.timeout_ms,
          max_output: args.max_output,
        }, { timeout: (args.timeout_ms || 30000) + 5000 });

      case 'fb_observe':
        return await post(BROWSER_URL, '/observe', {});

      case 'fb_act': {
        const body = { obs: args.obs, action: args.action };
        if (args.text !== undefined) body.text = args.text;
        return await post(BROWSER_URL, '/act', body);
      }

      case 'fb_screenshot': {
        const body = {};
        if (args.full) body.full = true;
        if (args.selector) body.selector = args.selector;
        return await post(BROWSER_URL, '/shot', body);
      }

      case 'fb_task': {
        const taskBody = {
          goal: args.goal,
          url: args.url,
          values: args.values || {},
          confirm: args.confirm,
          max_actions: args.max_actions,
          max_ms: args.max_ms,
        };
        if (args.subgoal) taskBody.subgoal = args.subgoal;
        if (args.expected_outcome) taskBody.expected_outcome = args.expected_outcome;
        if (args.role) taskBody.role = args.role;
        return await post(DECIDER_URL, '/task', taskBody, { timeout: (args.max_ms || 60000) + 10000 });
      }

      case 'fb_task_continue': {
        const body = { task: args.task };
        if (args.text !== undefined) body.text = args.text;
        if (args.confirm !== undefined) body.confirm = args.confirm;
        if (args.subgoal) body.subgoal = args.subgoal;
        if (args.expected_outcome) body.expected_outcome = args.expected_outcome;
        if (args.values) body.values = args.values;
        if (args.max_ms) body.max_ms = args.max_ms;
        return await post(DECIDER_URL, '/task/continue', body, { timeout: (args.max_ms || 60000) + 10000 });
      }

      case 'fb_task_stop':
        return await post(DECIDER_URL, '/task/stop', { task: args.task });

      case 'fb_task_trace':
        return await get(DECIDER_URL, `/task?id=${encodeURIComponent(args.id)}`);

      case 'fb_decide':
        return await post(DECIDER_URL, '/decide', {
          state: args.state,
          questions: args.questions,
        });

      case 'fb_profile_info':
        return await get(BROWSER_URL, '/profile/info');

      case 'fb_profile_snapshot':
        return await getBinary(BROWSER_URL, '/profile/snapshot');

      case 'fb_profile_load':
        return await postBinary(BROWSER_URL, '/profile/load', args.snapshot_base64);

      case 'fb_profile_reset':
        return await post(BROWSER_URL, '/profile/reset', {});

      case 'fb_view_url':
        return { ok: true, url: `${BROWSER_URL}/view` };

      case 'fb_state':
        return await get(BROWSER_URL, '/state');

      case 'fb_screenshots_save':
        return await post(BROWSER_URL, '/screenshots/save', {});

      case 'fb_screenshots_list':
        return await get(BROWSER_URL, '/screenshots/list');

      case 'fb_net': {
        const code = `return await net(${args.count || 20}${args.filter ? `, ${JSON.stringify(args.filter)}` : ''})`;
        return await post(BROWSER_URL, '/run', { code });
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// --- MCP protocol (JSON-RPC 2.0 over stdio) ---

const PROTOCOL_VERSION = '2024-11-05';

const rl = createInterface({ input: stdin, terminal: false });

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'fast-browser-mcp', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) {
        respondError(id, -32602, `Unknown tool: ${name}`);
        break;
      }
      try {
        const result = await executeTool(name, args || {});
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
});

stderr.write('fast-browser-mcp: ready\n');
