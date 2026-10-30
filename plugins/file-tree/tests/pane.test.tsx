import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: {
    title: 'Files',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DISK: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  'C:/proj': [
    { name: 'src', kind: 'dir' },
    { name: 'node_modules', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
  ],
  'C:/proj/src': [
    { name: 'app.ts', kind: 'file' },
    { name: 'new.ts', kind: 'file' },
  ],
}

test('touched files form a tree, the folder can be browsed, a file is mentioned', async ($, on) => {
  mock.clock(on, { now: 0 })
  const filled: string[] = []
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('fs.exists', (_, e) => ({ value: !e.path.includes('new.ts') }))
  on('fs.list', (_, e) => ({
    value: (DISK[e.path.replace(/\\/g, '/')] ?? []).map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\src\\app.ts' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\src\\new.ts', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\README.md' })
  await $.tool.call({ tool: 'Read', file_path: 'D:\\notes\\todo.md' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^src\/$/ })).toBeDefined()
    expect(await ui.find({ key: 'f:src/app.ts' })).toBeDefined()
    expect((await ui.find({ key: 'f:src/app.ts' }))?.text).toBe('app.ts M')
    expect((await ui.find({ key: 'f:src/new.ts' }))?.text).toBe('new.ts A')
    expect(await ui.find({ type: 'Text', text: /Outside this folder/ })).toBeDefined()
    expect(await ui.find({ key: 'f:D:\\notes\\todo.md' })).toBeDefined()
    await ui.unmount()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'f:src/app.ts' })
    await ui.press({ key: 'mode-all' })
    expect(await ui.find({ key: 'd:src' })).toBeDefined()
    expect(await ui.find({ key: 'f:src/app.ts' })).toBeUndefined()
    await ui.press({ key: 'd:src' })
    expect(await ui.find({ key: 'f:src/app.ts' })).toBeDefined()
    await ui.press({ key: 'collapse' })
    await ui.press({ key: 'mode-touched' })
    await ui.unmount()
  }

  expect(filled).toEqual(['@src/app.ts ', '@src/app.ts '])
})
