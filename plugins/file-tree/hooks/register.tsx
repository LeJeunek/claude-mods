import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { Mode, Touch } from '../types'

const PANE = 'file-tree'
const TITLE = 'Files'

const touched = atom({ plugin: 'file-tree', key: 'touched' } as const, [])
const mode = atom({ plugin: 'file-tree', key: 'mode' } as const, 'touched')
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const rev = atom({ plugin: 'file-tree', key: 'rev' } as const, 0)
const isClosed = atom({ plugin: 'file-tree', key: 'isClosed' } as const, false)

const MAX_TOUCHED = 500
const PER_DIR = 200
const MAX_ROWS = 600

const READS = new Set(['Read'])
const EDITS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write'])
// Tools that may change what is on disk, so the full listing is read again after them.
const CHANGES_DISK = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Bash', 'PowerShell'])
const IGNORED = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.turbo',
  '.cache',
  'coverage',
])

type Args = Record<string, unknown>

type Row =
  | { kind: 'dir'; prefix: string; name: string; rel: string; isOpen: boolean | null; isHot: boolean; isDim: boolean }
  | { kind: 'file'; prefix: string; name: string; mention: string; touch: Touch | undefined; isLatest: boolean; isDim: boolean }
  | { kind: 'note'; prefix: string; text: string }

type Leaf = { name: string; mention: string; touch: Touch }
type Node = { dirs: Map<string, Node>; files: Map<string, Leaf> }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'file-tree',
      description: 'Show the files Claude touched this session in a side pane',
    })
    if (!(await read($, isClosed))) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('command.run', { command: 'file-tree' }, async $ => {
    await update($, isClosed, () => false)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'File tree opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, isClosed, () => true)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Args
    const path = text(args.file_path) || text(args.notebook_path)
    const isTracked = path !== '' && (READS.has(tool) || EDITS.has(tool))
    const existed = tool === 'Write' && path !== '' ? await $.fs.exists(path).catch(() => true) : true

    const ran = await next(e)
    const isOk = ran.deny === undefined && ran.isError !== true
    if (isOk && isTracked) {
      const at = await $.clock.now()
      const isEdit = EDITS.has(tool)
      await update($, touched, list => record(list, path, isEdit, !existed, at))
    }
    if (isOk && CHANGES_DISK.has(tool) && ran.isReadOnly !== true) {
      await update($, rev, n => n + 1)
    }

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, touched, () => [])
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, mode)
    const list = await read($, touched)
    const cwd = await $.session.cwd()
    const created = list.filter(t => t.isNew).length
    const edited = list.filter(t => t.edits > 0 && !t.isNew).length
    const looked = list.length - created - edited

    if (view === 'all') {
      // Subscribes the listing to tool calls that may have changed the disk.
      await read($, rev)
    }
    const rows =
      view === 'touched'
        ? touchedRows(list, cwd)
        : await allRows($, list, cwd, new Set(await read($, expanded)))

    const setMode = (next: Mode) => () => update($, mode, () => next)
    const mention = (target: string) => () =>
      $.prompt.fill({ text: `@${/\s/.test(target) ? `"${target}"` : target} `, mode: 'insert' })
    const toggle = (rel: string) => () =>
      update($, expanded, open => (open.includes(rel) ? open.filter(d => d !== rel) : [...open, rel]))

    const draw = (row: Row) => {
      const indent = row.prefix === '' ? null : (
        <Text mono dimColor>
          {row.prefix}
        </Text>
      )
      if (row.kind === 'note') {
        return (
          <Box flexDirection="row">
            {indent}
            <Text dimColor italic>
              {row.text}
            </Text>
          </Box>
        )
      }
      if (row.kind === 'dir') {
        const label = `${row.isOpen === null ? '' : row.isOpen ? '▾ ' : '▸ '}${row.name}/`
        const name = row.isDim ? <Text dimColor>{label}</Text> : <Text color="suggestion">{label}</Text>
        const hot = row.isHot ? <Text color="warning"> •</Text> : ''

        return (
          <Box flexDirection="row">
            {indent}
            {row.isOpen === null ? (
              <Text wrap="truncate-end">
                {name}
                {hot}
              </Text>
            ) : (
              <Button key={`d:${row.rel}`} plain onPress={toggle(row.rel)}>
                {name}
                {hot}
              </Button>
            )}
          </Box>
        )
      }
      const mark = badge(row.touch)

      return (
        <Box flexDirection="row">
          {indent}
          <Button key={`f:${row.mention}`} plain dimColor={row.isDim} onPress={mention(row.mention)}>
            {row.isLatest ? <Text color="claude">{row.name}</Text> : row.name}
            {mark !== null && <Text color={mark.color}> {mark.text}</Text>}
          </Button>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button
            key="mode-touched"
            label={`Touched ${list.length}`}
            variant={view === 'touched' ? 'primary' : 'secondary'}
            hotkey="t"
            onPress={setMode('touched')}
          />
          <Button
            key="mode-all"
            label="All files"
            variant={view === 'all' ? 'primary' : 'secondary'}
            hotkey="a"
            onPress={setMode('all')}
          />
          {view === 'all' && (
            <Button key="collapse" label="Collapse" onPress={() => update($, expanded, () => [])} />
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          <Text color="success">A</Text> {created} created · <Text color="warning">M</Text> {edited}{' '}
          edited · R {looked} read · click a file to mention it
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {view === 'touched' && list.length === 0 && (
            <Text dimColor>No files yet. Files Claude reads, edits or creates show up here.</Text>
          )}
          {rows.map(draw)}
        </Box>
      </Box>
    )
  })
}

function record(list: Touch[], path: string, isEdit: boolean, isNew: boolean, at: number): Touch[] {
  const key = identity(path)
  const found = list.find(t => identity(t.path) === key)
  const base = found ?? { path, reads: 0, edits: 0, isNew: false, at }
  const next: Touch = {
    ...base,
    reads: base.reads + (isEdit ? 0 : 1),
    edits: base.edits + (isEdit ? 1 : 0),
    isNew: base.isNew || (isEdit && isNew),
    at,
  }

  return [...list.filter(t => t !== found), next].slice(-MAX_TOUCHED)
}

function badge(touch: Touch | undefined): { text: string; color: string } | null {
  if (touch === undefined) {
    return null
  }
  if (touch.isNew) {
    return { text: 'A', color: 'success' }
  }
  if (touch.edits > 0) {
    return { text: touch.edits > 1 ? `M×${touch.edits}` : 'M', color: 'warning' }
  }

  return { text: 'R', color: 'inactive' }
}

function touchedRows(list: Touch[], cwd: string): Row[] {
  const here = node()
  const elsewhere = node()
  const latest = list.reduce<Touch | undefined>((a, t) => (a === undefined || t.at > a.at ? t : a), undefined)
  for (const touch of list) {
    const rel = relative(cwd, touch.path)
    const segments = (rel ?? norm(touch.path)).split('/').filter(s => s !== '')
    const name = segments.pop()
    if (name === undefined) {
      continue
    }
    let at = rel === null ? elsewhere : here
    for (const segment of segments) {
      let child = at.dirs.get(segment)
      if (child === undefined) {
        child = node()
        at.dirs.set(segment, child)
      }
      at = child
    }
    at.files.set(name, { name, mention: rel ?? touch.path, touch })
  }

  const rows: Row[] = []
  walkTouched(here, '', 0, latest, rows)
  if (elsewhere.dirs.size > 0 || elsewhere.files.size > 0) {
    rows.push({ kind: 'note', prefix: '', text: 'Outside this folder' })
    walkTouched(elsewhere, '', 0, latest, rows)
  }

  return rows
}

function walkTouched(at: Node, prefix: string, depth: number, latest: Touch | undefined, rows: Row[]) {
  const dirs = [...at.dirs.entries()].sort(([a], [b]) => byName(a, b))
  const files = [...at.files.values()].sort((a, b) => byName(a.name, b.name))
  const total = dirs.length + files.length
  let index = 0
  for (const [name, child] of dirs) {
    const isLast = ++index === total
    // A folder holding only one folder is drawn with it on one row: src/components/
    let label = name
    let inner = child
    for (let only = soleDir(inner); only !== null; only = soleDir(inner)) {
      label = `${label}/${only[0]}`
      inner = only[1]
    }
    rows.push({
      kind: 'dir',
      prefix: prefix + branch(isLast, depth),
      name: label,
      rel: label,
      isOpen: null,
      isHot: false,
      isDim: false,
    })
    walkTouched(inner, prefix + stem(isLast, depth), depth + 1, latest, rows)
  }
  for (const leaf of files) {
    const isLast = ++index === total
    rows.push({
      kind: 'file',
      prefix: prefix + branch(isLast, depth),
      name: leaf.name,
      mention: leaf.mention,
      touch: leaf.touch,
      isLatest: leaf.touch === latest,
      isDim: false,
    })
  }
}

async function allRows($: EngineInterface, list: Touch[], cwd: string, open: Set<string>) {
  // Windows paths compare without case.
  const fold = isWindowsPath(norm(cwd)) ? (path: string) => path.toLowerCase() : (path: string) => path
  const byRel = new Map<string, Touch>()
  const hot = new Set<string>()
  for (const touch of list) {
    const rel = relative(cwd, touch.path)
    if (rel === null) {
      continue
    }
    byRel.set(fold(rel), touch)
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      hot.add(fold(parts.slice(0, i).join('/')))
    }
  }
  const latest = list.reduce<Touch | undefined>((a, t) => (a === undefined || t.at > a.at ? t : a), undefined)
  const rows: Row[] = []
  const root = norm(cwd).replace(/\/+$/, '')
  await walkAll($, '', '', 0, { root, open, byRel, hot, latest, fold }, rows)

  return rows
}

type WalkContext = {
  root: string
  open: Set<string>
  byRel: Map<string, Touch>
  hot: Set<string>
  latest: Touch | undefined
  fold: (path: string) => string
}

async function walkAll($: EngineInterface, rel: string, prefix: string, depth: number, ctx: WalkContext, rows: Row[]) {
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(rel === '' ? ctx.root : `${ctx.root}/${rel}`)
  } catch {
    rows.push({ kind: 'note', prefix, text: "can't read this folder" })

    return
  }
  const sorted = [...entries].sort((a, b) =>
    a.kind === 'dir' && b.kind !== 'dir' ? -1 : b.kind === 'dir' && a.kind !== 'dir' ? 1 : byName(a.name, b.name),
  )
  const shown = sorted.slice(0, PER_DIR)
  const hidden = sorted.length - shown.length
  for (const [i, entry] of shown.entries()) {
    if (rows.length >= MAX_ROWS) {
      rows.push({ kind: 'note', prefix, text: '… listing cut short' })

      return
    }
    const isLast = i === shown.length - 1 && hidden === 0
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const isDim = IGNORED.has(entry.name)
    if (entry.kind === 'dir') {
      const isOpen = ctx.open.has(childRel)
      rows.push({
        kind: 'dir',
        prefix: prefix + branch(isLast, depth),
        name: entry.name,
        rel: childRel,
        isOpen,
        isHot: ctx.hot.has(ctx.fold(childRel)),
        isDim,
      })
      if (isOpen) {
        await walkAll($, childRel, prefix + stem(isLast, depth), depth + 1, ctx, rows)
      }
      continue
    }
    const touch = ctx.byRel.get(ctx.fold(childRel))
    rows.push({
      kind: 'file',
      prefix: prefix + branch(isLast, depth),
      name: entry.name,
      mention: childRel,
      touch,
      isLatest: touch !== undefined && touch === ctx.latest,
      isDim: isDim || entry.kind === 'other',
    })
  }
  if (hidden > 0) {
    rows.push({ kind: 'note', prefix: prefix + branch(true, depth), text: `… ${hidden} more` })
  }
}

function node(): Node {
  return { dirs: new Map(), files: new Map() }
}

function soleDir(at: Node): [string, Node] | null {
  if (at.files.size > 0 || at.dirs.size !== 1) {
    return null
  }

  return [...at.dirs.entries()][0] ?? null
}

function branch(isLast: boolean, depth: number) {
  return depth === 0 ? '' : isLast ? '└─ ' : '├─ '
}

function stem(isLast: boolean, depth: number) {
  return depth === 0 ? '' : isLast ? '   ' : '│  '
}

function byName(a: string, b: string) {
  const x = a.toLowerCase()
  const y = b.toLowerCase()

  return x < y ? -1 : x > y ? 1 : 0
}

function norm(path: string) {
  return path.replace(/\\/g, '/')
}

function isWindowsPath(path: string) {
  return /^[a-z]:\//i.test(path)
}

function identity(path: string) {
  const p = norm(path)

  return isWindowsPath(p) ? p.toLowerCase() : p
}

// The path relative to the session's folder, or null when it lies outside it.
function relative(cwd: string, path: string): string | null {
  const root = norm(cwd).replace(/\/+$/, '')
  const p = norm(path)
  if (!p.startsWith('/') && !isWindowsPath(p)) {
    return p.replace(/^\.\//, '')
  }
  const head = p.slice(0, root.length)
  const isInside = isWindowsPath(root) ? head.toLowerCase() === root.toLowerCase() : head === root

  return isInside && p[root.length] === '/' ? p.slice(root.length + 1) : null
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}
