import type { Register } from 'claude-code'

// The marker the engine's own closing line opens with.
const MARK = '✻'

// A finished turn's figures wait here for the row that draws them. A row only
// claims one within this window of its turn ending, so a row redrawn after a
// reload never takes another turn's numbers.
const STALE_MS = 10_000

type Stats = {
  /** `$.clock.now()` when the turn ended: the row's `done` time, and what
   * tells a fresh claim from a redraw after a reload. */
  doneAt: number
  out: number
  inp: number
  cacheRead: number
  cacheCreate: number
  /** Milliseconds from each request starting through its stop, across the turn's steps. */
  genMs: number
  /** Context window used, 0 to 100, when the session reported it. */
  ctxPercent?: number
}

/** Time the model spent streaming, by turn id, summed over its steps. */
const gen = new Map<string, number>()
/** Finished turns no row has drawn yet, oldest first. */
const pending: Stats[] = []
/** The figures a row drew, by its `requestId`, kept across redraws. */
const rows = new Map<string, Stats>()

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest === 0 ? `${m}m` : `${m}m ${rest}s`
  const h = Math.floor(m / 60)

  return `${h}h ${m % 60}m`
}

const fmtClock = (ms: number): string => {
  if (typeof Date !== 'function') return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''

  try {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

export const register: Register = on => {
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) gen.set(e.turnId, 0)

    return next(e)
  })

  // The stream is read for its timing alone: a turn's token counts are summed
  // for it already, and `turn.complete` carries the sum.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const stream = next(e)
    let stopAt = 0

    for await (const chunk of stream) {
      if (chunk.kind === 'stop') stopAt = await $.clock.now()

      yield chunk
    }

    if (e.agentId === undefined && startedAt > 0 && stopAt > startedAt) {
      gen.set(e.turnId, (gen.get(e.turnId) ?? 0) + (stopAt - startedAt))
    }
  })

  // A session that ends (a /clear, a /resume taking its place) leaves no turn
  // behind for the next one's row to claim.
  on('session.end', ($, e, next) => {
    pending.length = 0
    gen.clear()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage !== undefined) {
      const at = await $.clock.now()
      let ctxPercent: number | undefined

      try {
        const { context } = await $.session.usage()
        ctxPercent =
          context.percent ??
          (context.tokens !== undefined && context.window > 0
            ? Math.round((context.tokens / context.window) * 100)
            : undefined)
      } catch {
        ctxPercent = undefined
      }

      pending.push({
        doneAt: at,
        out: e.usage.output_tokens,
        inp: e.usage.input_tokens,
        cacheRead: e.usage.cache_read_input_tokens,
        cacheCreate: e.usage.cache_creation_input_tokens,
        genMs: gen.get(e.turnId) ?? 0,
        ctxPercent,
      })
      while (pending.length > 20) pending.shift()
    }

    gen.delete(e.turnId)

    return next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    // The line waits on background agents then: leave the engine's own.
    if (e.props.waitingFor !== undefined) return next(e)

    let stats = rows.get(e.requestId)

    if (stats === undefined) {
      const now = await $.clock.now()

      // A turn whose row was never drawn in time (a /resume, a line that waited
      // on background agents, a long pause) is not going to be drawn now, and
      // no later row may take it either: drop every stale entry, not just look
      // at the head, or one of them blocks every turn after it for good.
      while (pending.length > 0 && now - pending[0].doneAt > STALE_MS) pending.shift()

      const head = pending[0]
      if (head === undefined) return next(e)

      pending.shift()
      stats = head
      rows.set(e.requestId, stats)
      while (rows.size > 200) {
        const oldest = rows.keys().next().value
        if (oldest === undefined) break

        rows.delete(oldest)
      }
    }

    const { Box, Text } = $.ui.resolve(e)
    // The cache serves input alone, so output stays out of the denominator.
    const inputTokens = stats.inp + stats.cacheRead + stats.cacheCreate
    const seconds = stats.genMs / 1000
    const parts: string[] = []

    if (stats.out > 0 && seconds >= 0.2) parts.push(`${Math.round(stats.out / seconds)} tok/s`)
    if (inputTokens > 0) {
      parts.push(`${((stats.cacheRead / inputTokens) * 100).toFixed(2)}% cached`)
    }
    if (stats.ctxPercent !== undefined) parts.push(`${Math.max(0, 100 - stats.ctxPercent)}% ctx left`)

    const clock = fmtClock(stats.doneAt)

    return (
      <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2}>
          <Text dimColor>{MARK}</Text>
        </Box>
        <Text dimColor>
          {`${e.props.word} for ${fmtDuration(e.props.durationMs)}`}
          {clock === '' ? '' : ` · done ${clock}`}
          {parts.length === 0 ? '' : ` · ${parts.join(' · ')}`}
        </Text>
      </Box>
    )
  })
}
