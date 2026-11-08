// claude-subagent-router: the single ANTHROPIC_BASE_URL Claude Code talks to.
// Requests whose model is a routed name (ag/..., zen/..., or an alias from router.json) go to the
// Antigravity proxy, OpenCode Zen or OpenCode Go. Everything else is passed to api.anthropic.com byte for byte,
// so the main session keeps using the claude.ai subscription login.
// Credentials are never logged: the log holds route, model, status and timing only.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'router.json');
const LOG_PATH = path.join(HERE, 'router.log');
const ANTHROPIC_HOST = 'api.anthropic.com';
const USER_AGENT = 'claude-subagent-router/1.0 (Claude Code)';
const ROUTER_SESSION = randomUUID();
const keepAlive = new https.Agent({ keepAlive: true });

// ${NAME} or ${NAME:-default} in a config string is filled from the environment, so router.json
// can stay free of machine-specific values.
function expandEnv(v) {
  if (typeof v === 'string') {
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const val = process.env[name];
      if (val) return val;
      if (fallback !== undefined) return fallback;
      throw new Error(`router.json: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = expandEnv(v[k]);
  }
  return v;
}

let config = null;
let configMtime = 0;
function cfg() {
  try {
    const m = fs.statSync(CONFIG_PATH).mtimeMs;
    if (m !== configMtime) {
      config = expandEnv(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      configMtime = m;
    }
  } catch (e) {
    if (!config) throw e;
    log({ event: 'config_reload_failed', err: e.message });
  }
  return config;
}

// Local time with the machine's UTC offset, never a Z timestamp.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function log(o) {
  fs.appendFile(LOG_PATH, JSON.stringify({ t: stamp(), ...o }) + '\n', () => {});
}

function rotateLog() {
  try {
    if (fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.old');
  } catch {}
}

function matches(patterns = [], id) {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : p === id));
}

// "subagent" -> "ag/gemini-3.8-flash-high" -> { kind: 'antigravity', model: 'gemini-3.8-flash-high' }
// "go/kimi-k2.6" -> { kind: 'chat', provider: 'go', model: 'kimi-k2.6' }
function resolve(model) {
  const c = cfg();
  for (let i = 0; i < 5 && c.aliases?.[model]; i++) model = c.aliases[model];
  const slash = model.indexOf('/');
  const prefix = slash > 0 ? model.slice(0, slash) : '';
  const id = model.slice(slash + 1);
  if (prefix === 'ag') return { kind: 'antigravity', model: id };
  const p = c.providers?.[prefix];
  if (!p) return { kind: 'anthropic' };
  if (matches(p.unsupported, id)) return { kind: 'unsupported', provider: prefix, model: id };
  return { kind: matches(p.anthropicFormat, id) ? 'messages' : 'chat', provider: prefix, model: id };
}

function providerKey(name) {
  const file = cfg().authFile.replace(/^~/, os.homedir());
  return JSON.parse(fs.readFileSync(file, 'utf8'))[cfg().providers[name].authKey].key;
}

// OpenCode Go asks third-party clients for their own user agent and a stable per-session id.
function providerHeaders(req, body) {
  const session = req.headers['x-claude-code-session-id']
    || createHash('sha256').update(String(body.metadata?.user_id || ROUTER_SESSION)).digest('hex').slice(0, 32);
  return { 'user-agent': USER_AGENT, 'x-opencode-session': session };
}

const ERROR_TYPES = { 400: 'invalid_request_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

function sendError(res, status, message) {
  // A 401/403 from a non-Anthropic backend must not look like the subscription login failing.
  if (status === 401 || status === 403) status = 400;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: ERROR_TYPES[status] || 'api_error', message } }));
}

function upstreamMessage(text) {
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function passthrough(req, res, raw, done) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  if (raw.length) headers['content-length'] = String(raw.length);
  const up = https.request({ host: ANTHROPIC_HOST, port: 443, method: req.method, path: req.url, headers, agent: keepAlive }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
    ur.on('end', () => done(ur.statusCode));
  });
  up.on('error', (e) => { sendError(res, 502, `router: anthropic passthrough failed: ${e.message}`); done(502, { err: e.message }); });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  up.end(raw);
}

// Tool search (deferred tools, tool_reference blocks) is an Anthropic API feature. For other backends,
// send only the tools the model may call now: every non-deferred tool plus any deferred tool it has loaded.
function prepare(body, model, { stripCache }) {
  const b = structuredClone(body);
  b.model = model;
  const loaded = new Set();
  for (const m of b.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content) {
      if (blk.type !== 'tool_result' || !Array.isArray(blk.content)) continue;
      blk.content = blk.content.map((x) => {
        if (x.type !== 'tool_reference') return x;
        loaded.add(x.tool_name);
        return { type: 'text', text: `Tool loaded: ${x.tool_name}` };
      });
    }
  }
  if (Array.isArray(b.tools)) {
    b.tools = b.tools
      .filter((t) => t.input_schema && (!t.defer_loading || loaded.has(t.name)))
      .map(({ defer_loading, cache_control, ...t }) => t);
    if (!b.tools.length) { delete b.tools; delete b.tool_choice; }
  }
  for (const k of ['context_management', 'output_config', 'container', 'mcp_servers', 'betas', 'speed']) delete b[k];
  if (b.thinking?.type === 'adaptive') delete b.thinking;
  if (stripCache) removeCacheControl(b);
  return b;
}

function removeCacheControl(o) {
  if (Array.isArray(o)) return o.forEach(removeCacheControl);
  if (o && typeof o === 'object') {
    delete o.cache_control;
    Object.values(o).forEach(removeCacheControl);
  }
}

// Anthropic-format backends (Antigravity proxy, Zen/Go /messages): forward and pipe the reply as is.
function forwardAnthropic(targetUrl, extraHeaders, body, res, done) {
  const u = new URL(targetUrl);
  const data = Buffer.from(JSON.stringify(body));
  const lib = u.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    accept: body.stream ? 'text/event-stream' : 'application/json',
    'content-length': String(data.length),
    ...extraHeaders,
  };
  const up = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers }, (ur) => {
    if (ur.statusCode >= 400) {
      let text = '';
      ur.setEncoding('utf8');
      ur.on('data', (c) => (text += c));
      ur.on('end', () => { sendError(res, ur.statusCode, `${body.model}: ${upstreamMessage(text)}`); done(ur.statusCode, { err: upstreamMessage(text).slice(0, 300) }); });
      return;
    }
    const h = { ...ur.headers };
    delete h.connection;
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
    ur.on('end', () => done(ur.statusCode));
  });
  up.on('error', (e) => { sendError(res, 502, `router: ${u.host} unreachable: ${e.message}`); done(502, { err: e.message }); });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  up.end(data);
}

// ---- Anthropic Messages <-> OpenAI Chat Completions, for Zen/Go models served on /chat/completions ----

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image omitted]' : '')).filter(Boolean).join('\n');
}

function toOpenAI(b) {
  const messages = [];
  const system = typeof b.system === 'string' ? b.system : textOf(b.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of b.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((x) => x.type === 'text').map((x) => x.text).join('');
      const toolCalls = blocks.filter((x) => x.type === 'tool_use').map((x) => ({
        id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // Tool results become role:"tool" messages, which must directly follow the assistant tool calls.
    const parts = [];
    for (const x of blocks) {
      if (x.type === 'tool_result') {
        const out = textOf(x.content) || '(no output)';
        messages.push({ role: 'tool', tool_call_id: x.tool_use_id, content: x.is_error ? `Error: ${out}` : out });
      } else if (x.type === 'text') {
        parts.push({ type: 'text', text: x.text });
      } else if (x.type === 'image' && x.source?.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${x.source.media_type};base64,${x.source.data}` } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const out = { model: b.model, messages, stream: !!b.stream };
  if (b.stream) out.stream_options = { include_usage: true };
  if (b.max_tokens) out.max_tokens = b.max_tokens;
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  if (b.stop_sequences?.length) out.stop = b.stop_sequences;
  if (b.tools?.length) {
    out.tools = b.tools.map((t) => {
      const { $schema, ...parameters } = t.input_schema;
      return { type: 'function', function: { name: t.name, description: t.description || '', parameters } };
    });
    const tc = b.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
    if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  return out;
}

function toolArgs(s) {
  if (!s) return '{}';
  try { JSON.parse(s); return s; } catch { return '{}'; }
}

function stopReason(finish, hasTools) {
  if (hasTools) return 'tool_use';
  return finish === 'length' ? 'max_tokens' : 'end_turn';
}

function newMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

async function chatCompletions(url, headers, b, requestedModel, res, done) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(toOpenAI(b)),
    signal: abort.signal,
  });
  if (!r.ok) {
    const msg = upstreamMessage(await r.text());
    sendError(res, r.status, `${requestedModel}: ${msg}`);
    return done(r.status, { err: msg.slice(0, 300) });
  }

  if (!b.stream) {
    const j = await r.json();
    const m = j.choices?.[0]?.message || {};
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls || []) {
      content.push({ type: 'tool_use', id: tc.id || `toolu_${randomUUID().slice(0, 8)}`, name: tc.function.name, input: JSON.parse(toolArgs(tc.function.arguments)) });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: newMessageId(), type: 'message', role: 'assistant', model: requestedModel, content,
      stop_reason: stopReason(j.choices?.[0]?.finish_reason, (m.tool_calls || []).length > 0), stop_sequence: null,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
    }));
    return done(200);
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  sse('message_start', { message: { id: newMessageId(), type: 'message', role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

  let index = -1;
  let textOpen = false;
  let finish = null;
  let usage = null;
  // Tool calls are buffered and emitted whole at the end: providers differ in how they interleave argument chunks.
  const tools = new Map();
  const handle = (j) => {
    if (j.usage) usage = j.usage;
    const choice = j.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) {
      if (!textOpen) { index++; sse('content_block_start', { index, content_block: { type: 'text', text: '' } }); textOpen = true; }
      sse('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
    }
    for (const tc of d.tool_calls || []) {
      const k = tc.index ?? tools.size;
      if (!tools.has(k)) tools.set(k, { id: '', name: '', args: '' });
      const t = tools.get(k);
      if (tc.id && !t.id) t.id = tc.id;
      if (tc.function?.name && !t.name) t.name = tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { handle(JSON.parse(payload)); } catch {}
    }
  }

  if (textOpen) sse('content_block_stop', { index });
  for (const t of tools.values()) {
    index++;
    sse('content_block_start', { index, content_block: { type: 'tool_use', id: t.id || `toolu_${randomUUID().slice(0, 8)}`, name: t.name, input: {} } });
    sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: toolArgs(t.args) } });
    sse('content_block_stop', { index });
  }
  if (index === -1) {
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_stop', { index: 0 });
  }
  sse('message_delta', {
    delta: { stop_reason: stopReason(finish, tools.size > 0), stop_sequence: null },
    usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
  });
  sse('message_stop', {});
  res.end();
  done(200, { toolCalls: tools.size });
}

// Neither backend counts tokens the Anthropic way; Claude Code only needs an estimate here.
function countTokens(body, res, done) {
  const n = Math.ceil(JSON.stringify([body.system, body.messages, body.tools]).length / 4);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: n }));
  done(200);
}

function shape(body, req) {
  const tools = body.tools || [];
  return {
    keys: Object.keys(body),
    tools: tools.length,
    deferred: tools.filter((t) => t.defer_loading).length,
    betas: req.headers['anthropic-beta'] || '',
    sessionHeader: !!req.headers['x-claude-code-session-id'],
  };
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://router');

  if (url.pathname === '/router/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, aliases: cfg().aliases }));
  }

  const isMessages = req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens');
  let body = null;
  let route = { kind: 'anthropic' };
  if (isMessages) {
    try { body = JSON.parse(raw.toString('utf8')); route = resolve(body.model || ''); } catch {}
  }
  const done = (status, extra = {}) => {
    if (!isMessages && status < 400) return;
    log({
      path: url.pathname, model: body?.model, route: route.kind, target: route.model, status,
      ms: Date.now() - t0, stream: body?.stream, ...(cfg().logShapes && body ? shape(body, req) : {}), ...extra,
    });
  };

  // Debug aid: keep the last routed Claude Code request body (prompt content only, never headers) for replaying.
  if (route.kind !== 'anthropic' && cfg().captureFile && req.headers['x-claude-code-session-id'] && !url.pathname.endsWith('/count_tokens')) {
    fs.writeFile(cfg().captureFile, raw, () => {});
  }

  try {
    if (route.kind === 'anthropic') return passthrough(req, res, raw, done);
    if (url.pathname.endsWith('/count_tokens')) return countTokens(body, res, done);
    if (route.kind === 'antigravity') {
      return forwardAnthropic(`${cfg().antigravity.url}/v1/messages`, {}, prepare(body, route.model, { stripCache: false }), res, done);
    }
    if (route.kind === 'unsupported') {
      sendError(res, 400, `${body.model}: this model uses the OpenAI Responses or Google API, which the router does not translate`);
      return done(400);
    }
    const p = cfg().providers[route.provider];
    const key = providerKey(route.provider);
    const headers = providerHeaders(req, body);
    const prepared = prepare(body, route.model, { stripCache: true });
    if (route.kind === 'messages') {
      return forwardAnthropic(`${p.url}/messages`, { ...headers, 'x-api-key': key }, prepared, res, done);
    }
    return await chatCompletions(p.url, { ...headers, authorization: `Bearer ${key}` }, prepared, body.model, res, done);
  } catch (e) {
    if (e.name === 'AbortError') return done(499, { err: 'client closed' });
    sendError(res, 502, `router: ${e.message}`);
    done(502, { err: e.message });
  }
});

process.on('uncaughtException', (e) => log({ event: 'uncaught', err: e.stack || e.message }));
process.on('unhandledRejection', (e) => log({ event: 'unhandled', err: e?.stack || String(e) }));

server.requestTimeout = 0;
server.on('error', (e) => { log({ event: 'listen_failed', err: e.message }); process.exit(1); });
server.listen(cfg().port, '127.0.0.1', () => { rotateLog(); log({ event: 'started', port: cfg().port, pid: process.pid }); });
setInterval(rotateLog, 60 * 60 * 1000).unref();
