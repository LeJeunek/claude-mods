import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'savvy-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('the band follows a turn and its plan, then sums it up', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, { durations: [60_000, 60_000, 60_000] })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {} }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  // Stands for the engine's own band once the mod hands drawing back.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Write the band', status: 'in_progress' },
      { content: 'Test it', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: 'Edit', file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })
  await clock.advance(30_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Working$/ }))?.text).toBe('Working')
    expect(await ui.find({ type: 'Text', text: /0:30/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Step 1 of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file changed/ })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  await $.turn.complete({
    reason: 'answer',
    answer: 'done',
    turnId: 't1',
    durationMs: 30_000,
    isAborted: false,
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\/2 steps/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /quicker than usual/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeUndefined()
  await ui.unmount()
})

test('without a plan or history the bar sweeps while it learns', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /learning your pace/ })).toBeDefined()
  await ui.unmount()
})

