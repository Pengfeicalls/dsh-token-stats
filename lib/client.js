/**
 * dsh-token-stats — client bundle（纯 JS，免构建；常驻，重启不丢）
 *
 * 主页侧栏底部常驻 Token 卡片（当前会话）+ 详情卡（全部会话汇总/按模型/按会话），
 * 后端为同包 host 半区注册的 /dsh-token-stats/* 同源路由，用 fetch 调用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-stats',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement

    // ---- 同源 API ----
    async function api(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try { data = await res.json() } catch (e) { /* ignore */ }
      if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || ('请求失败 ' + res.status))
      return data
    }

    // ---- 跨组件共享的小 store：快照 + 弹层开关 ----
    let shared = null
    const snapSubs = new Set()
    function publish(snapshot) {
      shared = snapshot
      for (const fn of [...snapSubs]) { try { fn(snapshot) } catch (error) {} }
    }
    function subscribeSnapshot(fn) {
      snapSubs.add(fn)
      return () => { snapSubs.delete(fn) }
    }
    const openState = { open: false }
    const openSubs = new Set()
    function setOpen(open) {
      openState.open = open
      for (const fn of [...openSubs]) { try { fn(open) } catch (error) {} }
    }
    function subscribeOpen(fn) {
      openSubs.add(fn)
      return () => { openSubs.delete(fn) }
    }

    // ---- 格式化 ----
    function fmtInt(n) { return typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—' }
    function fmtCompact(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
      if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K'
      return String(Math.round(n))
    }
    function fmtRmb(v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
      if (v === 0) return '0.00'
      const digits = v >= 1 ? 2 : 4
      return v.toFixed(digits).replace(/\.?0+$/, '')
    }
    function fmtPct(v) { return typeof v === 'number' && Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—' }
    function fmtTime(t) {
      if (typeof t !== 'number' || t === 0) return '—'
      const d = new Date(t)
      const pad = (x) => String(x).padStart(2, '0')
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    function fmtModel(model) { return model && model !== 'unknown' ? model : '未知模型' }
    function cloneConfig(config) {
      if (!config || typeof config !== 'object') return null
      return JSON.parse(JSON.stringify(config))
    }

    // ---- 主页常驻小卡片（只展示当前会话）----
    function FooterCard(props) {
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
      const wide = props.wide !== false
      const current = useSessions((s) => (s ? s.current : undefined))
      const currentTitle = useSessions((s) => {
        if (!s || !s.current) return ''
        const row = s.byId && s.byId[s.current]
        return row && row.displayTitle ? row.displayTitle : ''
      })
      const currentRef = useRef(current)
      currentRef.current = current
      const [snapshot, setSnapshot] = useState(shared)
      const [open, setOpenHere] = useState(openState.open)
      const lastRev = useRef(null)

      useEffect(() => subscribeSnapshot(setSnapshot), [])
      useEffect(() => subscribeOpen(setOpenHere), [])

      useEffect(() => {
        lastRev.current = null
        let cancelled = false
        const run = async () => {
          if (cancelled) return
          const requested = currentRef.current
          if (!requested) { lastRev.current = null; return }
          try {
            const result = await api('/dsh-token-stats/snapshot', { sessionId: requested })
            if (cancelled || !result || typeof result !== 'object') return
            if (requested !== currentRef.current) return
            if (result.rev !== lastRev.current) {
              lastRev.current = result.rev
              publish(result)
            }
          } catch (error) { /* 瞬时失败：下一轮重试 */ }
        }
        run()
        const timer = setInterval(run, 2000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [current])

      if (!wide) {
        return h('button', {
          className: 'tk-rail tk-rail-fixed',
          type: 'button',
          title: 'Token 统计',
          'aria-label': 'Token 统计详情',
          onClick: () => setOpen(true),
        }, '¥')
      }

      const isCurrentSnap = snapshot !== null && snapshot.sessionId === current
      const summary = isCurrentSnap && snapshot.summary ? snapshot.summary : null
      const currency = snapshot && snapshot.config ? snapshot.config.currency : '¥'
      const hasData = summary !== null && summary.turns > 0
      const tokensText = hasData ? fmtCompact(summary.tokens) : '—'
      const amountText = hasData ? currency + fmtRmb(summary.cost) : currency + '—'
      const hitRate = hasData ? summary.hitRate : 0
      const barWidth = hasData ? Math.round(hitRate * 100) : 0
      const barClass = hasData && hitRate >= 0.5 ? 'tk-bar-fill' : 'tk-bar-fill tk-bar-fill-warn'
      const breakdown = hasData
        ? '输入 ' + fmtCompact(summary.input) + ' · 输出 ' + fmtCompact(summary.output) + ' · 缓存读 ' + fmtCompact(summary.cacheRead) + (summary.reasoning > 0 ? ' · 思考 ' + fmtCompact(summary.reasoning) : '')
        : '—'
      const headText = 'Token 统计 · ' + (currentTitle || '当前会话')
      const rootTitle = hasData
        ? fmtInt(summary.tokens) + ' tokens · ' + currency + fmtRmb(summary.cost) + '（' + breakdown + '）'
        : 'Token 统计（点击 ↗ 查看详情）'
      return h('div', { className: 'tk-card tk-card-fixed', title: rootTitle },
        h('button', {
          className: 'tk-arrow',
          type: 'button',
          'aria-label': '打开 Token 统计详情',
          title: '详情',
          onClick: (event) => { event.stopPropagation(); setOpen(true) },
        }, '\u2197'),
        h('div', { className: 'tk-card-head', title: headText }, headText),
        h('div', { className: 'tk-card-main' },
          h('span', { className: 'tk-num' }, tokensText),
          h('span', { className: 'tk-amt' }, amountText),
        ),
        h('div', { className: 'tk-card-break', title: breakdown }, breakdown),
        h('div', { className: 'tk-sub' },
          h('span', { className: 'tk-sub-label' }, '缓存命中'),
          h('div', { className: 'tk-bar' }, h('div', { className: barClass, style: { width: barWidth + '%' } })),
          h('span', { className: 'tk-sub-pct' }, hasData ? fmtPct(hitRate) : '—'),
          h('span', { className: 'tk-sub-turns' }, hasData ? summary.turns + ' 轮' : ''),
        ),
      )
    }

    // ---- 弹出详情卡（顶部汇总 + 按模型统计 = 全部会话；按会话统计 = 会话列表）----
    function DetailCard(props) {
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
      const sessionList = useSessions((s) => s)
      const sessionListRef = useRef(sessionList)
      sessionListRef.current = sessionList
      const [open, setOpenHere] = useState(openState.open)
      const [snapshot, setSnapshot] = useState(shared)
      const [overview, setOverview] = useState(null)
      const [sessionStats, setSessionStats] = useState(null)
      const [showConfig, setShowConfig] = useState(false)
      const [draft, setDraft] = useState(null)
      const [newModel, setNewModel] = useState('')
      const [saving, setSaving] = useState(false)

      useEffect(() => subscribeOpen(setOpenHere), [])
      useEffect(() => subscribeSnapshot(setSnapshot), [])
      useEffect(() => {
        if (!open) return
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])
      useEffect(() => { if (!open) { setShowConfig(false); setSessionStats(null); setOverview(null) } }, [open])
      useEffect(() => {
        if (showConfig) {
          const cfg = (overview && overview.config) || (snapshot && snapshot.config)
          setDraft(cloneConfig(cfg) || { rate: 7.2, currency: '¥', priceMap: {} })
        }
      }, [showConfig])

      // 打开详情时拉取全部会话统计（顶部汇总 + 按模型 + 按会话），每 10 秒刷新
      useEffect(() => {
        if (!open) return
        let cancelled = false
        const run = async () => {
          try {
            const list = sessionListRef.current
            if (!list || !Array.isArray(list.ids)) return
            const res = await api('/dsh-token-stats/list', { sessionIds: list.ids.slice(0, 60) })
            if (cancelled || !res || typeof res !== 'object' || !Array.isArray(res.rows)) return
            setOverview({
              summary: res.summary || null,
              models: Array.isArray(res.models) ? res.models : [],
              config: res.config || null,
            })
            const byId = list.byId || {}
            const rows = res.rows.map((row) => {
              const meta = byId[row.sessionId]
              return {
                ...row,
                title: meta && meta.displayTitle ? meta.displayTitle : row.sessionId,
                updatedAt: meta && typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
              }
            }).sort((a, b) => b.updatedAt - a.updatedAt)
            setSessionStats(rows)
          } catch (error) {}
        }
        run()
        const timer = setInterval(run, 10000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [open])

      if (!open) return null

      const summary = (overview && overview.summary) || (snapshot && snapshot.summary) || null
      const models = (overview && Array.isArray(overview.models)) ? overview.models : (snapshot && Array.isArray(snapshot.models) ? snapshot.models : [])
      const config = (overview && overview.config) || (snapshot && snapshot.config) || null
      const currency = config ? config.currency : '¥'

      const refreshAfterSave = async () => {
        if (snapshot && snapshot.sessionId) {
          try {
            const result = await api('/dsh-token-stats/snapshot', { sessionId: snapshot.sessionId })
            if (result && typeof result === 'object') publish(result)
          } catch (error) {}
        }
      }
      const handleSave = async () => {
        if (saving || !draft) return
        setSaving(true)
        try {
          await api('/dsh-token-stats/save-config', { config: draft })
          await refreshAfterSave()
          setShowConfig(false)
        } catch (error) {}
        setSaving(false)
      }
      const handleReset = async () => {
        if (saving) return
        setSaving(true)
        try {
          await api('/dsh-token-stats/save-config', { config: null })
          await refreshAfterSave()
          setShowConfig(false)
        } catch (error) {}
        setSaving(false)
      }

      const stat = (label, value) => h('div', { className: 'tk-stat', key: label },
        h('div', { className: 'tk-stat-label' }, label),
        h('div', { className: 'tk-stat-value' }, value),
      )
      const summaryNodes = [
        stat('总 Token', summary ? fmtInt(summary.tokens) : '—'),
        stat('金额', summary ? currency + fmtRmb(summary.cost) : currency + '—'),
        stat('缓存命中率', summary ? fmtPct(summary.hitRate) : '—'),
        stat('对话轮次', summary ? String(summary.turns) : '—'),
      ]

      const mTotal = models.reduce((acc, row) => ({
        input: acc.input + row.input,
        output: acc.output + row.output,
        cacheRead: acc.cacheRead + row.cacheRead,
        total: acc.total + row.total,
        cost: acc.cost + row.cost,
      }), { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 })
      const modelRows = models.map((row) => h('tr', { key: row.model },
        h('td', { className: 'tk-td-model' }, fmtModel(row.model)),
        h('td', { className: 'tk-td-num' }, fmtInt(row.input)),
        h('td', { className: 'tk-td-num' }, fmtInt(row.output)),
        h('td', { className: 'tk-td-num' }, fmtInt(row.cacheRead)),
        h('td', { className: 'tk-td-num' }, fmtPct(row.hitRate)),
        h('td', { className: 'tk-td-num tk-td-strong' }, fmtInt(row.total)),
        h('td', { className: 'tk-td-num tk-td-strong' }, row.priced ? currency + fmtRmb(row.cost) : '未定价'),
      ))
      const modelEmpty = h('tr', { key: 'model-empty' }, h('td', { className: 'tk-empty', colSpan: 7 }, '暂无 Token 数据'))
      const modelTotalRow = h('tr', { className: 'tk-total-row', key: 'model-total' },
        h('td', { className: 'tk-td-model' }, '总计'),
        h('td', { className: 'tk-td-num' }, fmtInt(mTotal.input)),
        h('td', { className: 'tk-td-num' }, fmtInt(mTotal.output)),
        h('td', { className: 'tk-td-num' }, fmtInt(mTotal.cacheRead)),
        h('td', { className: 'tk-td-num' }, summary ? fmtPct(summary.hitRate) : '—'),
        h('td', { className: 'tk-td-num tk-td-strong' }, fmtInt(mTotal.total)),
        h('td', { className: 'tk-td-num tk-td-strong' }, currency + fmtRmb(mTotal.cost)),
      )

      const sess = Array.isArray(sessionStats) ? sessionStats : []
      const sTotal = sess.reduce((acc, row) => ({ tokens: acc.tokens + row.tokens, cost: acc.cost + row.cost }), { tokens: 0, cost: 0 })
      const sessRows = sess.map((row) => h('tr', { key: row.sessionId },
        h('td', { className: 'tk-td-session', title: (row.title || '') + (row.firstPrompt ? '\n' + row.firstPrompt : '') },
          h('div', { className: 'tk-sess-title' }, row.title),
          row.firstPrompt ? h('div', { className: 'tk-sess-prompt' }, row.firstPrompt) : null,
        ),
        h('td', { className: 'tk-td-num' }, fmtTime(row.updatedAt)),
        h('td', { className: 'tk-td-num' }, String(row.turns)),
        h('td', { className: 'tk-td-num' }, fmtInt(row.tokens)),
        h('td', { className: 'tk-td-num tk-td-strong' }, currency + fmtRmb(row.cost)),
      ))
      const sessEmpty = h('tr', { key: 'sess-empty' }, h('td', { className: 'tk-empty', colSpan: 5 }, '暂无会话数据'))
      const sessTotalRow = h('tr', { className: 'tk-total-row', key: 'sess-total' },
        h('td', { className: 'tk-td-model' }, '总计'),
        h('td', {}),
        h('td', {}),
        h('td', { className: 'tk-td-num tk-td-strong' }, fmtInt(sTotal.tokens)),
        h('td', { className: 'tk-td-num tk-td-strong' }, currency + fmtRmb(sTotal.cost)),
      )

      const setPriceOf = (model, field, value) => setDraft({
        ...draft,
        priceMap: { ...draft.priceMap, [model]: { ...draft.priceMap[model], [field]: Number(value) || 0 } },
      })
      const removeModel = (model) => {
        const next = { ...draft.priceMap }
        delete next[model]
        setDraft({ ...draft, priceMap: next })
      }
      const addModel = () => {
        const key = newModel.trim()
        if (!key || !draft || draft.priceMap[key]) return
        setDraft({ ...draft, priceMap: { ...draft.priceMap, [key]: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } })
        setNewModel('')
      }
      const configRows = draft ? Object.keys(draft.priceMap).map((model) => {
        const price = draft.priceMap[model]
        return h('div', { className: 'tk-config-model', key: model },
          h('span', { className: 'tk-cfg-model', title: model }, model),
          h('input', { type: 'number', min: '0', step: '0.001', value: String(price.input), onChange: (e) => setPriceOf(model, 'input', e.target.value) }),
          h('input', { type: 'number', min: '0', step: '0.001', value: String(price.cacheRead), onChange: (e) => setPriceOf(model, 'cacheRead', e.target.value) }),
          h('input', { type: 'number', min: '0', step: '0.001', value: String(price.cacheWrite), onChange: (e) => setPriceOf(model, 'cacheWrite', e.target.value) }),
          h('input', { type: 'number', min: '0', step: '0.001', value: String(price.output), onChange: (e) => setPriceOf(model, 'output', e.target.value) }),
          h('button', { className: 'tk-ghost tk-del', type: 'button', title: '移除', 'aria-label': '移除 ' + model, onClick: () => removeModel(model) }, '\u00d7'),
        )
      }) : []
      const configPanel = showConfig && draft ? h('div', { className: 'tk-config' },
        h('div', { className: 'tk-config-title' }, '价格与汇率配置（USD / 1M tokens）'),
        h('div', { className: 'tk-config-note' }, '默认价参考 DeepSeek 官方 2026-07 定价（永久降价后）；如按峰谷/新方案计费请在下方调整。'),
        h('div', { className: 'tk-config-row' },
          h('label', { className: 'tk-config-field' },
            h('span', {}, '汇率（RMB/USD）'),
            h('input', { type: 'number', min: '0', step: '0.01', value: String(draft.rate), onChange: (e) => setDraft({ ...draft, rate: Number(e.target.value) || 0 }) }),
          ),
          h('label', { className: 'tk-config-field' },
            h('span', {}, '货币符号'),
            h('input', { type: 'text', value: draft.currency, onChange: (e) => setDraft({ ...draft, currency: e.target.value }) }),
          ),
        ),
        h('div', { className: 'tk-config-table' },
          h('div', { className: 'tk-config-head' },
            h('span', { className: 'tk-cfg-model' }, '模型'),
            h('span', {}, '输入'),
            h('span', {}, '缓存读'),
            h('span', {}, '缓存写'),
            h('span', {}, '输出'),
            h('span', { className: 'tk-cfg-del' }),
          ),
          ...configRows,
          h('div', { className: 'tk-config-model' },
            h('input', { className: 'tk-cfg-model tk-new-model', type: 'text', placeholder: '新增模型 ID', value: newModel, onChange: (e) => setNewModel(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') addModel() } }),
            h('button', { className: 'tk-btn tk-btn-ghost', type: 'button', onClick: addModel }, '添加'),
          ),
        ),
        h('div', { className: 'tk-config-actions' },
          h('button', { className: 'tk-btn', type: 'button', disabled: saving, onClick: handleSave }, '保存'),
          h('button', { className: 'tk-btn tk-btn-ghost', type: 'button', disabled: saving, onClick: handleReset }, '恢复默认'),
          h('button', { className: 'tk-btn tk-btn-ghost', type: 'button', disabled: saving, onClick: () => setShowConfig(false) }, '取消'),
        ),
      ) : null

      return h('div', { className: 'tk-detail-root', onClick: () => setOpen(false) },
        h('div', { className: 'tk-detail-card', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'tk-detail-header' },
            h('div', { className: 'tk-detail-title' }, 'Token 统计'),
            h('div', { className: 'tk-detail-actions' },
              h('button', { className: 'tk-ghost', type: 'button', 'aria-label': '配置价格与汇率', title: '配置', onClick: () => setShowConfig(!showConfig) }, '\u2699'),
              h('button', { className: 'tk-ghost', type: 'button', 'aria-label': '关闭', title: '关闭', onClick: () => setOpen(false) }, '\u00d7'),
            ),
          ),
          h('div', { className: 'tk-stats' }, ...summaryNodes),
          h('div', { className: 'tk-section' },
            h('div', { className: 'tk-section-title' }, '按模型统计（全部会话）'),
            h('table', { className: 'tk-table' },
              h('thead', null, h('tr', null,
                h('th', { className: 'tk-th-model' }, '模型'),
                h('th', null, '输入'),
                h('th', null, '输出'),
                h('th', null, '缓存读'),
                h('th', null, '命中率'),
                h('th', null, '合计'),
                h('th', null, '金额'),
              )),
              h('tbody', null, models.length > 0 ? [...modelRows, modelTotalRow] : [modelEmpty, modelTotalRow]),
            ),
          ),
          h('div', { className: 'tk-section' },
            h('div', { className: 'tk-section-title' }, '按会话统计（' + sess.length + ' 个对话，按最近更新排序）'),
            h('table', { className: 'tk-table' },
              h('thead', null, h('tr', null,
                h('th', { className: 'tk-th-session' }, '对话'),
                h('th', null, '时间'),
                h('th', null, '轮次'),
                h('th', null, 'Token'),
                h('th', null, '金额'),
              )),
              h('tbody', null, sess.length > 0 ? [...sessRows, sessTotalRow] : [sessEmpty, sessTotalRow]),
            ),
          ),
          configPanel,
        ),
      )
    }

    // ---- 注册插槽 ----
    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'token-stats', order: 30, label: 'Token 统计' },
        (props) => h(FooterCard, props),
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'token-stats-detail', order: 100, label: 'Token 统计详情' },
        (props) => h(DetailCard, props),
      ))
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      try {
        ctx.on('dispose', () => { try { styleEl.remove() } catch (e) { /* ignore */ } })
      } catch (e) { /* ignore */ }
    }
    const inject = ['slots']

    // ---- 唯一前缀样式，主题变量 + color-mix ----
    const CSS =
      '.tk-card{box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:8px 10px 7px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.35;position:relative;transition:border-color .15s ease,background-color .15s ease}' +
      '.tk-card:hover{border-color:var(--dsw-alias-border-l2)}' +
      '.tk-card-fixed{position:fixed;left:12px;bottom:116px;z-index:8;width:228px;max-width:calc(100vw - 32px);box-shadow:0 6px 24px color-mix(in srgb,var(--dsw-alias-bg-base) 28%,transparent)}' +
      '.tk-card-head{color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.04em;padding-right:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.tk-card-main{display:flex;align-items:baseline;gap:7px;min-width:0;padding-right:18px}' +
      '.tk-num{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;white-space:nowrap}' +
      '.tk-amt{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}' +
      '.tk-arrow{position:absolute;top:5px;right:5px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;padding:0;font-size:12px;line-height:1;transition:background-color .12s ease,color .12s ease,transform .08s ease}' +
      '.tk-arrow:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-primary)}' +
      '.tk-arrow:active{transform:scale(0.94)}' +
      '.tk-card-break{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:2px}' +
      '.tk-sub{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:10.5px}' +
      '.tk-bar{flex:1;min-width:20px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);overflow:hidden}' +
      '.tk-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}' +
      '.tk-bar-fill-warn{background:var(--dsw-alias-state-warn-primary)}' +
      '.tk-sub-pct{font-variant-numeric:tabular-nums;min-width:34px;text-align:right}' +
      '.tk-sub-turns{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '.tk-rail{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;font-weight:700;padding:0;transition:background-color .12s ease,color .12s ease,transform .08s ease}' +
      '.tk-rail-fixed{position:fixed;left:16px;bottom:92px;z-index:8}' +
      '.tk-rail:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-primary)}' +
      '.tk-rail:active{transform:scale(0.94)}' +
      '.tk-detail-root{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);pointer-events:auto;animation:tk-fade .15s ease}' +
      '@keyframes tk-fade{from{opacity:0}to{opacity:1}}' +
      '.tk-detail-card{box-sizing:border-box;width:min(760px,100%);max-height:min(84vh,680px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:14px 16px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent);pointer-events:auto;font-size:12.5px}' +
      '.tk-detail-header{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.tk-detail-title{font-size:14px;font-weight:650}' +
      '.tk-detail-actions{display:flex;gap:4px}' +
      '.tk-ghost{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font-size:13px;line-height:1;padding:0;transition:background-color .12s ease,color .12s ease,transform .08s ease}' +
      '.tk-ghost:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-primary)}' +
      '.tk-ghost:active{transform:scale(0.94)}' +
      '.tk-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
      '.tk-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}' +
      '.tk-stat-label{color:var(--dsw-alias-label-secondary);font-size:10.5px}' +
      '.tk-stat-value{font-weight:650;font-variant-numeric:tabular-nums;font-size:13.5px;white-space:nowrap}' +
      '.tk-section{display:flex;flex-direction:column;gap:6px}' +
      '.tk-section-title{font-weight:600;font-size:12px}' +
      '.tk-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}' +
      '.tk-table th{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:10.5px;text-align:right;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}' +
      '.tk-table th:first-child,.tk-table td:first-child{text-align:left}' +
      '.tk-table td{padding:4px 6px;text-align:right;white-space:nowrap;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 50%,transparent)}' +
      '.tk-td-model{max-width:180px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}' +
      '.tk-td-session{max-width:230px;overflow:hidden}' +
      '.tk-sess-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:var(--dsw-alias-label-primary)}' +
      '.tk-sess-prompt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--dsw-alias-label-secondary);max-width:220px}' +
      '.tk-td-num{font-variant-numeric:tabular-nums}' +
      '.tk-td-strong{font-weight:600}' +
      '.tk-total-row td{border-top:1px solid var(--dsw-alias-border-l2);border-bottom:none;font-weight:650}' +
      '.tk-empty{text-align:center !important;color:var(--dsw-alias-label-secondary);padding:14px 0 !important}' +
      '.tk-config{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}' +
      '.tk-config-title{font-weight:600;font-size:12px}' +
      '.tk-config-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}' +
      '.tk-config-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.tk-config-field{display:flex;flex-direction:column;gap:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}' +
      '.tk-config input[type=number],.tk-config input[type=text]{box-sizing:border-box;width:88px;padding:4px 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;outline:none}' +
      '.tk-config input:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.tk-config-model{display:flex;gap:6px;align-items:center}' +
      '.tk-cfg-model{flex:1;min-width:90px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary)}' +
      '.tk-new-model{flex:1;min-width:120px;max-width:220px}' +
      '.tk-cfg-del{width:24px}' +
      '.tk-del{font-size:12px}' +
      '.tk-config-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}' +
      '.tk-btn{box-sizing:border-box;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,white);font-size:12px;font-weight:600;cursor:pointer;transition:filter .12s ease,transform .08s ease}' +
      '.tk-btn:hover{filter:brightness(1.08)}' +
      '.tk-btn:active{transform:scale(0.97)}' +
      '.tk-btn:disabled{opacity:.5;cursor:default}' +
      '.tk-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}' +
      '.tk-btn-ghost:hover{filter:none;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}'

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
