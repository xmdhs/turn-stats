import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

const ROW = {
  plugin: 'turn-stats',
  component: 'TurnDuration',
  requestId: 'row-1',
  props: { word: 'Worked', durationMs: 92_000, isExpanded: false },
} as const

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 2000,
  output_tokens: 4000,
  cache_read_input_tokens: 94_000,
  cache_creation_input_tokens: 0,
}

/** The line's text, whitespace flattened. */
const lineOf = async (ui: Pick<Mounted<'terminal', 'TurnDuration'>, 'find'>) =>
  ((await ui.find({ type: 'Text', text: /Worked/ }))?.text ?? '').replaceAll(/\s+/g, ' ')

test('a finished turn appends its figures to the line', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 100_000, window: 200_000, percent: 50 },
      rateLimits: [],
    },
  }))
  on('clock.now', () => ({ value: Date.parse('2026-10-29T23:55:00') }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({
    answer: 'done',
    durationMs: 92_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: USAGE,
  })

  const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  const line = await lineOf(ui)

  expect(line).toContain('Worked for 1m 32s')
  expect(line.toLowerCase()).toContain('done 11:55 pm')
  expect(line).toContain('97.92% cached')
  expect(line).toContain('50% ctx left')
  // The total that four counts made is gone.
  expect(line).not.toContain('tok ·')
  expect(line).not.toContain('100k')
  await ui.unmount()
})

test('a row with no turn of its own is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...ROW, requestId: 'other', surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('a row that waits on agents is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('clock.now', () => ({ value: 0 }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: USAGE,
  })

  const ui = await $.ui.mount({
    ...ROW,
    requestId: 'waiting',
    surface: 'terminal',
    props: {
      word: 'Worked',
      durationMs: 1000,
      waitingFor: { agents: [{ id: 'a1', agentType: 'Explore' }], workflows: 0 },
    },
  })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('throughput includes time before the first response chunk', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('turn.complete', () => ({ text: '' }))
  // Beneath: three seconds before the first chunk, then four seconds streaming.
  on('turn.step', async function* () {
    await clock.sleep(3000)
    yield { kind: 'text', index: 0, text: 'a' }
    await clock.sleep(4000)
    yield {
      kind: 'stop',
      stopReason: 'end_turn',
      usage: {
        model: 'm',
        input_tokens: 1,
        output_tokens: 4000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }

    return { turnId: 't3', index: 0, answer: 'a', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  const step = $.turn.step({ turnId: 't3', index: 0, model: 'm', messageCount: 1 })
  const reading = (async () => {
    for await (const chunk of step) void chunk
  })()

  await clock.advance(7000)
  await reading

  await $.turn.complete({
    answer: '',
    durationMs: 4000,
    isAborted: false,
    turnId: 't3',
    reason: 'answer',
    usage: USAGE,
  })

  const ui = await $.ui.mount({ ...ROW, requestId: 'speed', surface: 'terminal' })
  const line = await lineOf(ui)

  expect(line).toContain('571 tok/s')
  await ui.unmount()
})

test('a turn whose row was never drawn does not block the turns after it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 100_000, window: 200_000, percent: 50 },
      rateLimits: [],
    },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  // The turn ends and its row is never drawn in time: a /resume, a line that
  // waited on background agents, or a pause before the screen settles.
  await $.turn.complete({
    answer: 'a',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: USAGE,
  })
  await clock.advance(60_000)

  await $.turn.complete({
    answer: 'b',
    durationMs: 1000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: USAGE,
  })

  // The next turn's row takes its own figures, not the abandoned ones.
  const ui = await $.ui.mount({ ...ROW, requestId: 'row-2', surface: 'terminal' })
  const line = await lineOf(ui)

  expect(line).toContain('50% ctx left')
  await ui.unmount()
})

test('a resumed session does not hand its rows the turn that ended', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 100_000, window: 200_000, percent: 50 },
      rateLimits: [],
    },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  // The turn ends, then the person resumes: the conversation it belonged to is gone.
  await $.turn.complete({
    answer: 'a',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: USAGE,
  })
  await clock.advance(1000)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })

  // Resuming redraws the transcript at once: no history row takes the old figures.
  const history = await $.ui.mount({ ...ROW, requestId: 'hist-1', surface: 'terminal' })

  expect(await lineOf(history)).toBe('')
  await history.unmount()

  await $.turn.complete({
    answer: 'b',
    durationMs: 1000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: USAGE,
  })

  const ui = await $.ui.mount({ ...ROW, requestId: 'row-new', surface: 'terminal' })
  const line = await lineOf(ui)

  expect(line).toContain('50% ctx left')
  await ui.unmount()
})

test('the line draws on every surface', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 100_000, window: 200_000, percent: 50 },
      rateLimits: [],
    },
  }))
  on('clock.now', () => ({ value: Date.parse('2026-10-29T23:55:00') }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    await $.turn.complete({
      answer: 'done',
      durationMs: 92_000,
      isAborted: false,
      turnId: `t-${surface}`,
      reason: 'answer',
      usage: USAGE,
    })

    const ui = await $.ui.mount({ ...ROW, requestId: `s-${surface}`, surface })
    const line = await lineOf(ui)

    expect(line).toContain('Worked for 1m 32s')
    expect(line).toContain('50% ctx left')
    await ui.unmount()
  }
})
