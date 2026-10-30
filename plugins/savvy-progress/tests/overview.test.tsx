import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'savvy-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
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

// The widths of a drawn tree's bordered Boxes: the overview's tiles.
function tileWidths(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) {
    return []
  }
  const { props, children } = node as { props?: Record<string, unknown>; children?: unknown[] }
  const own = props?.borderStyle === undefined ? [] : [props.width]

  return [...own, ...(children ?? []).flatMap(tileWidths)]
}

test('More opens a brief overview of the turn: its tools, latest actions and changed files', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('fs.exists', (_, e) => ({ value: !e.path.includes('new.ts') }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Fix the login', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/src/app.ts' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/src/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await $.tool.call({ tool: 'Grep', pattern: 'login' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/proj/src/app.ts' })
  // A file an agent changes counts among the turn's changed files.
  await $.agent.spawn({
    tool_use_id: 'toolu-agent',
    prompt: 'tidy',
    description: 'Tidy the helpers',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/src/helpers.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' })

  const closed = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await closed.find({ type: 'Button', text: /More/ })) !== undefined).toBe(true)
  expect(await closed.find({ key: 'tile:files' })).toBeUndefined()
  await closed.press({ key: 'expand' })
  await closed.unmount()

  const opener = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await opener.press({ key: 'tile:tools' })
  await opener.press({ key: 'tile:files' })
  await opener.unmount()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // A grid of tiles, each with its count and a one-line summary.
    expect((await ui.find({ key: 'tile:tools' }))?.text).toBe('▾ Tools')
    await shows(ui, /^6 calls$/)
    await shows(ui, /^Read ×2 · Edit ×1 · Write ×1 · Bash ×1 · Grep ×1$/)
    // Opened, its rows: newest call first, each cell in its own column.
    await shows(ui, /^Run the tests$/)
    await shows(ui, /^"login"$/)
    await shows(ui, /^3 changed$/)
    await shows(ui, /^1 new · 2 modified$/)
    await shows(ui, /^src\/new\.ts$/)
    await shows(ui, /^src\/helpers\.ts$/)
    expect((await ui.find({ key: 'tile:agents' }))?.text).toBe('▸ Agents')
    // The tiles sit on a grid: all three side by side at 100 columns, every one the same width.
    expect(tileWidths(await ui.drawn()).join(' ')).toBe('33% 33% 33%')
    await ui.unmount()
  }

  // Narrower, the grid keeps even columns: two to a row, the third under the first.
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 70 }, surface: 'desktop' })
  expect(tileWidths(await narrow.drawn()).join(' ')).toBe('50% 50% 50%')
  await narrow.unmount()

  await $.turn.complete({ reason: 'answer', answer: 'done', turnId: 't1', durationMs: 5, isAborted: false })
  const done = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await shows(done, /Done in/)
  await shows(done, /^src\/new\.ts$/)
  await done.press({ key: 'expand' })
  expect(await done.find({ key: 'tile:files' })).toBeUndefined()
  await done.unmount()
})
