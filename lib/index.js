/**
 * dsh-token-stats — host 半区（静态 profile 插件，常驻，重启不丢）
 *
 * 会话用量聚合 + 价格/汇率配置（settings 命名空间 token-stats），
 * 通过 webServer 注册同源 HTTP 路由供 client fetch 调用：
 *   POST /dsh-token-stats/snapshot    当前会话快照（卡片）
 *   POST /dsh-token-stats/list        全部会话：rows + 全局 summary/models + config（详情卡）
 *   POST /dsh-token-stats/save-config 保存价格/汇率配置
 */
export const name = 'dsh-token-stats'
// webServer 是硬依赖：cordis 会等它就绪后才挂载本插件（否则 ctx.get('webServer') 可能是 undefined，路由注册不上）。
export const inject = ['webServer']

// ---------------------------------------------------------------- 默认配置（DeepSeek 官方 2026-07 定价，USD/1M tokens，汇率 7.2）
const DEFAULTS = {
  rate: 7.2,
  currency: '¥',
  priceMap: {
    'deepseek-v4-flash': { input: 0.14, cacheRead: 0.0028, cacheWrite: 0.0028, output: 0.28 },
    'deepseek-v4-pro': { input: 0.435, cacheRead: 0.003625, cacheWrite: 0.003625, output: 0.87 },
    'deepseek-chat': { input: 0.28, cacheRead: 0.028, cacheWrite: 2.8, output: 0.42 },
    'deepseek-reasoner': { input: 0.55, cacheRead: 0.14, cacheWrite: 0.55, output: 2.19 },
  },
}

function toNum(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function sanitizeConfig(input) {
  const src = (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input : {}
  const rate = toNum(src.rate, DEFAULTS.rate) || DEFAULTS.rate
  const currency = typeof src.currency === 'string' && src.currency.trim() !== '' ? src.currency.trim() : DEFAULTS.currency
  const priceMap = {}
  const srcMap = (typeof src.priceMap === 'object' && src.priceMap !== null && !Array.isArray(src.priceMap)) ? src.priceMap : {}
  const merged = new Map()
  for (const entry of Object.entries(DEFAULTS.priceMap)) merged.set(entry[0], entry[1])
  for (const entry of Object.entries(srcMap)) merged.set(entry[0], entry[1])
  for (const pair of merged) {
    const model = pair[0]
    const raw = pair[1]
    const base = DEFAULTS.priceMap[model] || {}
    const p = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {}
    priceMap[model] = {
      input: toNum(p.input, base.input !== undefined ? base.input : 0),
      cacheRead: toNum(p.cacheRead, base.cacheRead !== undefined ? base.cacheRead : 0),
      cacheWrite: toNum(p.cacheWrite, base.cacheWrite !== undefined ? base.cacheWrite : toNum(p.input, 0)),
      output: toNum(p.output, base.output !== undefined ? base.output : 0),
    }
  }
  return { rate, currency, priceMap }
}

// settings 命名空间需要一个 schemastery 风格的 schema：可调用、toJSON、type/dict 供 describe 走查。
function makeSchema() {
  const schema = (data) => sanitizeConfig(data)
  schema.type = 'object'
  schema.meta = { default: DEFAULTS }
  schema.dict = {
    rate: { type: 'number' },
    currency: { type: 'string' },
    priceMap: { type: 'dict', inner: { type: 'number' } },
  }
  schema.toJSON = () => ({
    type: 'object',
    fields: {
      rate: { type: 'number' },
      currency: { type: 'string' },
      priceMap: { type: 'dict', inner: { type: 'number' } },
    },
  })
  return schema
}

// ---------------------------------------------------------------- 会话用量聚合（增量）
const states = new Map()

function newState(sessionId) {
  return {
    sessionId,
    lastSeq: 0,
    header: null,
    currentTurn: null,
    pendingPrompts: new Map(),
    firstPrompt: '',
    firstPromptIsUser: false,
    models: new Map(),
    turns: new Map(),
  }
}

function extractPrompt(message) {
  if (!message || typeof message !== 'object') return null
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      const flat = block.text.replace(/\s+/g, ' ').trim()
      const text = flat.length > 42 ? flat.slice(0, 42) + '…' : flat
      return { text, isUser: !!(message.source && message.source.kind === 'user') }
    }
  }
  return null
}

function foldEvent(state, event) {
  if (!event || typeof event !== 'object') return
  const seq = typeof event.seq === 'number' ? event.seq : 0
  if (seq !== 0 && seq <= state.lastSeq) return
  if (seq !== 0) state.lastSeq = seq
  const type = event.type
  const data = (typeof event.data === 'object' && event.data !== null) ? event.data : {}
  if (type === 'request/header') {
    const header = data.header
    if (header && typeof header === 'object' && header.config && typeof header.config === 'object') {
      const cfg = header.config
      state.header = {
        provider: typeof cfg.provider === 'string' ? cfg.provider : '',
        model: typeof cfg.model === 'string' ? cfg.model : '',
      }
    }
    return
  }
  if (type === 'turn/start') {
    if (typeof data.turn === 'number') state.currentTurn = data.turn
    return
  }
  if (type === 'user/message') {
    const prompt = extractPrompt(data)
    if (prompt !== null) {
      if (state.firstPrompt === '') {
        state.firstPrompt = prompt.text
        state.firstPromptIsUser = prompt.isUser
      } else if (!state.firstPromptIsUser && prompt.isUser) {
        state.firstPrompt = prompt.text
        state.firstPromptIsUser = true
      }
      const turn = typeof state.currentTurn === 'number' ? state.currentTurn : null
      if (turn !== null) {
        const prev = state.pendingPrompts.get(turn)
        if (prev === undefined || (!prev.isUser && prompt.isUser)) {
          state.pendingPrompts.set(turn, prompt)
        }
        if (state.pendingPrompts.size > 200) {
          const oldest = state.pendingPrompts.keys().next().value
          state.pendingPrompts.delete(oldest)
        }
        const existing = state.turns.get(turn)
        if (existing !== undefined && existing.prompt === '') existing.prompt = prompt.text
      }
    }
    return
  }
  if (type !== 'assistant/message') return
  const usage = (typeof data.usage === 'object' && data.usage !== null) ? data.usage : null
  if (usage === null) return
  const input = toNum(usage.inputTokens, 0)
  const output = toNum(usage.outputTokens, 0)
  const cacheRead = toNum(usage.cacheReadTokens, 0)
  const cacheWrite = toNum(usage.cacheWriteTokens, 0)
  const reasoning = toNum(usage.reasoningTokens, 0)
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) return
  const model = state.header !== null && state.header.model !== '' ? state.header.model : 'unknown'
  let modelEntry = state.models.get(model)
  if (modelEntry === undefined) {
    modelEntry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: new Set() }
    state.models.set(model, modelEntry)
  }
  modelEntry.input += input
  modelEntry.output += output
  modelEntry.cacheRead += cacheRead
  modelEntry.cacheWrite += cacheWrite
  modelEntry.reasoning += reasoning
  const turn = typeof data.turn === 'number' ? data.turn : null
  if (turn !== null) {
    modelEntry.turns.add(turn)
    let turnEntry = state.turns.get(turn)
    if (turnEntry === undefined) {
      const pending = state.pendingPrompts.get(turn)
      turnEntry = { turn, time: event.time, model, prompt: pending !== undefined ? pending.text : '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      state.turns.set(turn, turnEntry)
    }
    turnEntry.input += input
    turnEntry.output += output
    turnEntry.cacheRead += cacheRead
    turnEntry.cacheWrite += cacheWrite
    turnEntry.reasoning += reasoning
    turnEntry.model = model
  }
}

async function ensure(ctx, sessionId) {
  let state = states.get(sessionId)
  if (state !== undefined) return state
  state = newState(sessionId)
  states.set(sessionId, state)
  const query = ctx.get('sessionQuery')
  const persistence = ctx.get('sessionPersistence')
  try {
    let events = null
    if (query !== undefined && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : null
    } else if (persistence !== undefined && typeof persistence.load === 'function') {
      const inspection = await persistence.load(sessionId)
      events = inspection && Array.isArray(inspection.events) ? inspection.events : null
    }
    if (events !== null) for (const event of events) foldEvent(state, event)
  } catch (error) {
    console.error('dsh-token-stats: backfill failed for', sessionId, error)
  }
  return state
}

function hitRateOf(input, cacheRead) {
  const denominator = input + cacheRead
  if (denominator <= 0) return 0
  const ratio = cacheRead / denominator
  return ratio > 1 ? 1 : ratio
}

function costOf(config, model, usage) {
  const price = config.priceMap[model]
  if (price === undefined) return 0
  const usd = (usage.input * price.input + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite + usage.output * price.output) / 1e6
  return usd * config.rate
}

function summarizeState(state, config) {
  let totalTokens = 0
  let totalCost = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalReasoning = 0
  for (const pair of state.models) {
    const model = pair[0]
    const entry = pair[1]
    totalInput += entry.input
    totalOutput += entry.output
    totalCacheRead += entry.cacheRead
    totalCacheWrite += entry.cacheWrite
    totalReasoning += entry.reasoning
    totalTokens += entry.input + entry.output + entry.cacheRead + entry.cacheWrite
    totalCost += costOf(config, model, entry)
  }
  return {
    tokens: totalTokens,
    cost: totalCost,
    hitRate: hitRateOf(totalInput, totalCacheRead),
    turns: state.turns.size,
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
    reasoning: totalReasoning,
  }
}

function buildSnapshot(state, config) {
  const models = []
  for (const pair of state.models) {
    const model = pair[0]
    const entry = pair[1]
    const total = entry.input + entry.output + entry.cacheRead + entry.cacheWrite
    models.push({
      model,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      reasoning: entry.reasoning,
      total,
      cost: costOf(config, model, entry),
      hitRate: hitRateOf(entry.input, entry.cacheRead),
      priced: config.priceMap[model] !== undefined,
    })
  }
  models.sort((a, b) => b.cost - a.cost)
  const turns = []
  for (const entry of state.turns.values()) {
    turns.push({
      turn: entry.turn,
      time: entry.time,
      model: entry.model,
      prompt: entry.prompt || '',
      tokens: entry.input + entry.output + entry.cacheRead + entry.cacheWrite,
      cost: costOf(config, entry.model, entry),
    })
  }
  turns.sort((a, b) => a.turn - b.turn)
  return {
    rev: configRev + ':' + state.lastSeq,
    sessionId: state.sessionId,
    summary: summarizeState(state, config),
    models,
    turns,
    config: { rate: config.rate, currency: config.currency, priceMap: config.priceMap },
  }
}

// ---------------------------------------------------------------- HTTP 辅助（同源保护）
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch { return false }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > (cap || 1024 * 1024)) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function routeGuard(req, res) {
  if (!sameOrigin(req)) { json(res, 403, { ok: false, error: 'forbidden' }); return false }
  return true
}

// ---------------------------------------------------------------- 插件入口
let configRev = 0
let memoryConfig = null
let scope = null

export const apply = (ctx) => {
  // ---- 配置：优先 settings 命名空间持久化，失败回退内存 ----
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      scope = settings.register('token-stats', makeSchema(), { base: DEFAULTS })
    } catch (error) {
      console.error('dsh-token-stats: settings register failed, keeping in-memory config', error)
      scope = null
    }
  }
  if (scope !== null) {
    ctx.on('settings/updated', (ns) => {
      if (ns === 'token-stats') configRev += 1
    })
  }
  const readConfig = () => {
    if (scope !== null) {
      const resolved = scope.get()
      if (resolved !== undefined) return resolved
    }
    if (memoryConfig !== null) return memoryConfig
    return sanitizeConfig(null)
  }

  // ---- 路由 ----
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const disposers = []
    const route = (path, handler) => {
      try { disposers.push(webServer.register({ kind: 'exact', path, handler })) } catch (e) { console.error('dsh-token-stats: route register failed', path, e) }
    }

    route('/dsh-token-stats/snapshot', async (req, res) => {
      if (!routeGuard(req, res)) return
      try {
        const body = await readBody(req)
        const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : null
        if (sessionId === null) { json(res, 200, { ok: false, error: 'missing sessionId' }); return }
        const state = await ensure(ctx, sessionId)
        json(res, 200, buildSnapshot(state, readConfig()))
      } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
    })

    route('/dsh-token-stats/list', async (req, res) => {
      if (!routeGuard(req, res)) return
      try {
        const body = await readBody(req)
        const ids = body && Array.isArray(body.sessionIds) ? body.sessionIds.filter((x) => typeof x === 'string') : []
        const config = readConfig()
        const rows = []
        const globalModels = new Map()
        const g = { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0 }
        for (const id of ids.slice(0, 60)) {
          try {
            const state = await ensure(ctx, id)
            const sum = summarizeState(state, config)
            rows.push({ sessionId: id, turns: sum.turns, tokens: sum.tokens, cost: sum.cost, firstPrompt: state.firstPrompt || '' })
            g.tokens += sum.tokens
            g.cost += sum.cost
            g.input += sum.input
            g.output += sum.output
            g.cacheRead += sum.cacheRead
            g.cacheWrite += sum.cacheWrite
            g.reasoning += sum.reasoning
            g.turns += sum.turns
            for (const pair of state.models) {
              const model = pair[0]
              const entry = pair[1]
              let gm = globalModels.get(model)
              if (gm === undefined) {
                gm = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
                globalModels.set(model, gm)
              }
              gm.input += entry.input
              gm.output += entry.output
              gm.cacheRead += entry.cacheRead
              gm.cacheWrite += entry.cacheWrite
              gm.reasoning += entry.reasoning
            }
          } catch (error) {
            rows.push({ sessionId: id, turns: 0, tokens: 0, cost: 0, firstPrompt: '' })
          }
        }
        const models = []
        for (const pair of globalModels) {
          const model = pair[0]
          const entry = pair[1]
          const total = entry.input + entry.output + entry.cacheRead + entry.cacheWrite
          models.push({
            model,
            input: entry.input,
            output: entry.output,
            cacheRead: entry.cacheRead,
            cacheWrite: entry.cacheWrite,
            reasoning: entry.reasoning,
            total,
            cost: costOf(config, model, entry),
            hitRate: hitRateOf(entry.input, entry.cacheRead),
            priced: config.priceMap[model] !== undefined,
          })
        }
        models.sort((a, b) => b.cost - a.cost)
        json(res, 200, {
          rows,
          summary: {
            tokens: g.tokens,
            cost: g.cost,
            hitRate: hitRateOf(g.input, g.cacheRead),
            turns: g.turns,
            input: g.input,
            output: g.output,
            cacheRead: g.cacheRead,
            cacheWrite: g.cacheWrite,
            reasoning: g.reasoning,
          },
          models,
          config: { rate: config.rate, currency: config.currency, priceMap: config.priceMap },
        })
      } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
    })

    route('/dsh-token-stats/save-config', async (req, res) => {
      if (!routeGuard(req, res)) return
      try {
        const body = await readBody(req)
        const next = sanitizeConfig(body && typeof body === 'object' ? body.config : null)
        memoryConfig = next
        configRev += 1
        if (scope !== null) {
          try { await scope.replace(next) } catch (error) { console.error('dsh-token-stats: failed to persist config', error) }
        }
        json(res, 200, { ok: true, config: next })
      } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
    })

    ctx.on('dispose', () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })
  } else {
    console.error('dsh-token-stats: webServer unavailable, routes not registered')
  }

  // ---- 根作用域事件：接收所有会话日志事件，只增量折叠已建状态的会话（按需懒建）----
  ctx.on('session/event', (session, event) => {
    if (!session || typeof session !== 'object') return
    const id = typeof session.id === 'string' ? session.id : null
    if (id === null) return
    const state = states.get(id)
    if (state !== undefined) foldEvent(state, event)
  })
}
