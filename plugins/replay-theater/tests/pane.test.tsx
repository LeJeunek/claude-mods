import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  props: {
    title: 'Replay',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

type Drawing = {
  find: (query: { type?: string; text?: RegExp }) => Promise<unknown>
  findAll: (query: object) => Promise<{ type: string; text: string }[]>
}

// Finds an element, or fails naming what was drawn instead.
async function shows(ui: Drawing, type: string, text: RegExp) {
  if ((await ui.find({ type, text })) === undefined) {
    const drawn = (await ui.findAll({})).filter(x => x.type !== 'Box').map(x => `${x.type}: ${x.text}`)
    throw new Error(`no ${type} matching ${text}; drawn: ${drawn.join(' | ')}`)
  }
}

test('tool calls become scenes in acts, and the session plays back', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      return {
        result: {
          structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }],
        },
        text: 'ok',
      }
    }
    if (String(e.tool) === 'Bash') {
      return { result: {}, text: 'tests passed' }
    }

    return { result: {}, text: '1\thello' }
  })

  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await shows(ui, 'Text', /Nothing to replay yet/)
    await ui.unmount()
  }

  await $.turn.start({ text: 'Fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\src\\login.ts' })
  await clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'old', new_string: 'new' })
  await $.turn.start({ text: 'Now run the tests', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await shows(ui, 'Text', /ACT 2/)
    await shows(ui, 'Text', /Now run the tests/)
    await shows(ui, 'Text', /● LIVE/)
    await shows(ui, 'Code', /tests passed/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'act-prev' })
  await shows(ui, 'Text', /Fix the login bug/)
  await shows(ui, 'Text', /Scene 1 of 3/)

  await ui.press({ key: 'play' })
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('⏸ Pause')
  await clock.advance(1_500)
  await shows(ui, 'Text', /Scene 2 of 3/)
  const diff = await ui.find({ type: 'Code', text: /@@ -10,1 \+10,1 @@/ })
  expect(diff?.props.format).toBe('diff')

  await clock.advance(1_500)
  await shows(ui, 'Text', /Scene 3 of 3/)
  await clock.advance(1_500)
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶ Play')

  await ui.press({ key: 'speed' })
  expect((await ui.find({ key: 'speed' }))?.props.label).toBe('2×')
  await ui.press({ key: 'first' })
  await ui.press({ key: 'next' })
  await shows(ui, 'Text', /Scene 2 of 3/)
  await ui.press({ key: 'live' })
  await shows(ui, 'Text', /● LIVE/)
  await ui.unmount()
})

function spawn(description: string, subagentType: string) {
  return {
    tool_use_id: `toolu-${description}`,
    prompt: description,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as const
}

test('agents get swimlanes, a cast list, and their own tag on stage', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('agent.list', () => ({ value: [] }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `agent-${++spawned}` }))

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Audit the auth flow', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/README.md' })
  await $.agent.spawn(spawn('Find auth handlers', 'Explore'))
  await $.agent.spawn(spawn('Find session storage', 'Explore'))
  await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Grep', pattern: 'session', agentId: 'agent-2' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/src/login.ts', agentId: 'agent-1' })
  // The engine's own fork is no cast member: its calls stay off the stage.
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/memory.md', agentId: 'fork-1' })
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: 'found', turnId: 'a1', durationMs: 5, isAborted: false })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      await shows(ui, 'Text', /^Main/)
      await shows(ui, 'Text', /^✓ Explore 1/)
      await shows(ui, 'Text', /^◐ Explore 2/)
    } else {
      // A timeline: a lane per loop, a bar per call, each bar naming its call on hover.
      const timeline = await ui.find({ type: 'Svg' })
      const source = String(timeline?.props.source ?? '')
      expect(source).toContain('>Main</text>')
      expect(source).toContain('>✓ Explore 1</text>')
      expect(source).toContain('>◐ Explore 2</text>')
      expect(source).toContain('<title>✓ Explore 1 · Grep login · ✓ 0ms</title>')
      expect(timeline?.props.isInteractive).toBe(true)
    }
    await shows(ui, 'Text', /Find auth handlers/)
    await shows(ui, 'Text', /Scene 4 of 4/)
    await shows(ui, 'Text', /⧉ Explore 1/)
    await shows(ui, 'Text', /Agent task: Find auth handlers/)
    expect(await ui.find({ type: 'Text', text: /memory\.md/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:agent-2' })
  await shows(ui, 'Text', /Scene 3 of 4/)
  await shows(ui, 'Text', /⧉ Explore 2/)
  await ui.unmount()
})
