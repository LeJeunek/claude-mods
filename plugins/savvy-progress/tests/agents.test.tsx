import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const PANEL = {
  plugin: 'savvy-progress',
  component: 'Pane',
  requestId: 'agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

type Drawing = {
  find: (query: { type?: string; text?: RegExp }) => Promise<unknown>
  findAll: (query: { type?: string }) => Promise<{ type: string; text: string }[]>
}

// Finds a Text, or fails naming what was drawn instead.
async function shows(ui: Drawing, text: RegExp) {
  if ((await ui.find({ type: 'Text', text })) === undefined) {
    const drawn = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    throw new Error(`no Text matching ${text}; drawn: ${drawn.join(' | ')}`)
  }
}

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

// The world beneath the plugin: a session, a clock, an agent list, and model steps that report usage.
// Tool calls succeed unless the test answers them itself.
function world(on: On, opened: string[], hasOwnTools = false) {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  if (!hasOwnTools) {
    on('tool.call', () => ({ result: {} }))
  }
  on('agent.list', () => ({
    value: [
      { id: 'agent-1', type: 'Explore', description: 'Research competitor launches', status: 'running' },
      { id: 'agent-2', type: 'Plan', description: 'Design the launch graphics', status: 'running' },
      { id: 'agent-3', type: 'general-purpose', description: 'Build the landing page', status: 'running' },
    ],
  }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-${++spawned}` }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: e.model,
        input_tokens: 2_000,
        output_tokens: 3_000,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 0,
      },
    }
  })

  return clock
}

test('agents get a summary on the band and a card each in the Agents panel', async ($, on) => {
  const opened: string[] = []
  const clock = world(on, opened)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Launch kit', turnId: 'main' })
  await $.agent.spawn(spawn('Research competitor launches', 'Explore'))
  await $.agent.spawn(spawn('Design the launch graphics', 'Plan'))
  // A model step of the first agent: its model, effort and what the step cost.
  const step = $.turn.step({
    turnId: 'a1',
    index: 0,
    model: 'claude-opus-5-5',
    effort: 'high',
    messageCount: 1,
    agentId: 'agent-1',
  })
  for await (const chunk of step) {
    void chunk
  }
  await step.result
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Find launches', status: 'completed', activeForm: 'Finding launches' },
      { content: 'Read the posts', status: 'completed', activeForm: 'Reading the posts' },
      { content: 'Compare pricing', status: 'completed', activeForm: 'Comparing pricing' },
      { content: 'Launch dates', status: 'in_progress', activeForm: 'Checking launch dates' },
    ],
    agentId: 'agent-1',
  })
  await $.tool.call({ tool: 'Glob', pattern: '**/*.tsx', agentId: 'agent-2' })
  // A loop no spawn announced and no list names (the engine's own fork) stays out.
  await $.tool.call({ tool: 'Read', file_path: '/memory.md', agentId: 'fork-1' })
  await clock.advance(12_000)

  expect(opened).toContain('agents')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await shows(ui, /^Agents · /)
    // Each agent goes by the role it plays: an Explore agent researches; a Plan agent asked to design designs.
    await shows(ui, /2 running · Researcher: Thinking · Designer: Thinking/)
    await ui.unmount()
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANEL, surface })
    await shows(ui, /^Agents$/)
    await shows(ui, /^Launch kit$/)
    await shows(ui, /^≈\$0\.08$/)
    await shows(ui, /^55\.0k$/)
    await shows(ui, /^0:12$/)
    await shows(ui, /RUNNING · 2/)
    await shows(ui, /^Research competitor launches$/)
    await shows(ui, /^careful$/)
    await shows(ui, /Opus 5\.5 · high · Explore as $/)
    await shows(ui, /^Researcher$/)
    await shows(ui, /Opus 5\.5 · Plan as $/)
    await shows(ui, /^Designer$/)
    await shows(ui, /^3\/4 · Launch dates$/)
    await shows(ui, /^≈\$0\.08 · 0:12$/)
    await shows(ui, /^Design the launch graphics$/)
    await shows(ui, /1 tool · Thinking/)
    expect(await ui.find({ type: 'Text', text: /memory/ })).toBeUndefined()
    const pictures = await ui.findAll({ type: 'Svg' })
    expect(pictures.length).toBe(surface === 'terminal' ? 0 : 4)
    if (surface === 'terminal') {
      // The terminal's bars are text: the first agent's plan is 3.5 of 4 steps along, 32 of 36 cells.
      await shows(ui, /^━{32}$/)
    }
    await ui.unmount()
  }

  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: 'found', turnId: 'a1', durationMs: 12_000, isAborted: false })
  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  await shows(ui, /RUNNING · 1/)
  await shows(ui, /DONE · 1/)
  await ui.unmount()
})

test('finished agents stay on the band into the next turn, then age out', async ($, on) => {
  const clock = world(on, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'first', turnId: 't1' })
  await $.agent.spawn(spawn('Research competitor launches', 'Explore'))
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: 'done', turnId: 'a1', durationMs: 5, isAborted: false })
  await $.turn.complete({ reason: 'answer', answer: 'ok', turnId: 't1', durationMs: 5, isAborted: false })

  await $.turn.start({ text: 'second', turnId: 't2' })
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await shows(ui, /1 done/)
  await ui.unmount()

  // Left idle, with nothing working, the finished agent still ages off.
  await $.turn.complete({ reason: 'answer', answer: 'ok', turnId: 't2', durationMs: 5, isAborted: false })
  await clock.advance(6 * 60_000)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Agents · / })).toBeUndefined()
  await ui.unmount()

  await $.turn.start({ text: 'third', turnId: 't3' })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Agents · / })).toBeUndefined()
  await ui.unmount()
})

test('a card opens a Tools list: what the agent ran, how often, and what is running now', async ($, on) => {
  world(on, [], true)
  let midCall = ''
  // The engine refuses one read, and the Bash call looks at the panel while it is still running.
  on('tool.call', async (_, e) => {
    if (String(e.tool) === 'Read' && JSON.stringify(e).includes('secret')) {
      return { deny: 'not allowed' }
    }
    if (String(e.tool) === 'Bash') {
      const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
      midCall = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
      await ui.unmount()
    }

    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Launch kit', turnId: 'main' })
  await $.agent.spawn(spawn('Research competitor launches', 'Explore'))
  await $.agent.spawn(spawn('Design the launch graphics', 'Plan'))
  await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read', file_path: '/src/login.ts', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read', file_path: '/src/secret.ts', agentId: 'agent-1' })

  const closed = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect((await closed.find({ key: 'tools:agent-1' }))?.text).toBe('▸ Tools · 3 calls')
  expect((await closed.find({ key: 'tools:agent-2' }))?.text).toBe('▸ Tools · 0 calls')
  expect(await closed.find({ type: 'Text', text: /^login\.ts$/ })).toBeUndefined()
  await closed.press({ key: 'tools:agent-1' })
  expect((await closed.find({ key: 'tools:agent-1' }))?.text).toBe('▾ Tools · 3 calls')
  await closed.unmount()

  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', agentId: 'agent-1' })
  expect(midCall).toContain('| ◌ | Bash | Run the tests |')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANEL, surface })
    expect((await ui.find({ key: 'tools:agent-1' }))?.text).toBe('▾ Tools · 4 calls')
    // The tally, most used first, then the calls, newest first.
    await shows(ui, /^Read ×2 · Grep ×1 · Bash ×1$/)
    await shows(ui, /^Run the tests$/)
    await shows(ui, /^secret\.ts$/)
    await shows(ui, /^⊘$/)
    await shows(ui, /^"login"$/)
    // The second card stays closed.
    expect((await ui.find({ key: 'tools:agent-2' }))?.text).toBe('▸ Tools · 0 calls')
    await ui.unmount()
  }

  const reopened = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  await reopened.press({ key: 'tools:agent-1' })
  expect(await reopened.find({ type: 'Text', text: /^Run the tests$/ })).toBeUndefined()
  await reopened.unmount()
})

test('the panel keeps the session: earlier agents stay listed, the tiles total the latest batch', async ($, on) => {
  const clock = world(on, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'First batch', turnId: 't1' })
  await $.agent.spawn(spawn('Research competitor launches', 'Explore'))
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: 'done', turnId: 'a1', durationMs: 5, isAborted: false })
  await clock.advance(10 * 60_000)
  await $.turn.start({ text: 'Second batch', turnId: 't2' })
  await $.agent.spawn(spawn('Design the launch graphics', 'Plan'))

  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  await shows(ui, /^Second batch$/)
  await shows(ui, /RUNNING · 1/)
  await shows(ui, /DONE · 1/)
  await shows(ui, /^Research competitor launches$/)
  await shows(ui, /This session: 2 agents/)
  await ui.unmount()
})
