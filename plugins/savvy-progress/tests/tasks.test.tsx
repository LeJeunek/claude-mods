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

test('the band follows the task tools a cloud session keeps its plan with', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  let created = 0
  on('tool.call', (_, e) => {
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'TaskCreate') {
      return { result: { task: { id: String(++created), subject: args.subject } } }
    }
    if (e.tool === 'TaskList') {
      return {
        result: {
          tasks: [
            { id: '2', subject: 'Test it', status: 'in_progress', blockedBy: [] },
            { id: '3', subject: 'Ship it', status: 'pending', blockedBy: [] },
          ],
        },
      }
    }

    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  const stepShown = async (pattern: RegExp) => {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: pattern })).toBeDefined()
      await ui.unmount()
    }
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the band', description: 'x' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Test it', description: 'y' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await stepShown(/Step 1 of 2/)

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await stepShown(/Step 2 of 2/)

  // A deleted task leaves the plan; TaskList's answer replaces it whole.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' })
  await stepShown(/Step 1 of 1/)
  await $.tool.call({ tool: 'TaskList' })
  await stepShown(/Step 1 of 2/)
})
