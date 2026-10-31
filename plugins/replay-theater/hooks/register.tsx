import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Act, AgentState, Cast, Kind, Scene, Status } from '../types'

const PANE = 'replay-theater'
const TITLE = 'Replay'

const scenes = atom({ plugin: 'replay-theater', key: 'scenes' } as const, [])
const acts = atom({ plugin: 'replay-theater', key: 'acts' } as const, [])
const cast = atom({ plugin: 'replay-theater', key: 'cast' } as const, [])
// The scene on stage, or -1 to follow the latest one live.
const cursor = atom({ plugin: 'replay-theater', key: 'cursor' } as const, -1)
const isPlaying = atom({ plugin: 'replay-theater', key: 'isPlaying' } as const, false)
const speed = atom({ plugin: 'replay-theater', key: 'speed' } as const, 1)
const isClosed = atom({ plugin: 'replay-theater', key: 'isClosed' } as const, false)

const MAX_SCENES = 400
const MAX_DIFF_LINES = 160
const MAX_CODE_LINES = 80
const MAX_OUTPUT_LINES = 40
const MAX_TEXT = 6000
const TICK_MS = 250
const SCENE_MS = 1500
const SPEEDS = [1, 2, 4, 0.5]
const SCRIPT_WINDOW = 9
const MAX_CAST = 100
const MAX_LANES = 8
const LANE_LABEL = 16

// Loop ids the session's agent list never named: the engine's own forks (memory, compaction).
const strangers = new Set<string>()

const CAST_STATES: Record<AgentState, { glyph: string; color: string; verb: string }> = {
  running: { glyph: '◐', color: 'claude', verb: 'working' },
  done: { glyph: '✓', color: 'success', verb: 'done' },
  failed: { glyph: '✗', color: 'error', verb: 'failed' },
  stopped: { glyph: '■', color: 'warning', verb: 'stopped' },
}

const ICONS: Record<Kind, string> = {
  read: '▸',
  edit: '✎',
  run: '$',
  search: '⌕',
  web: '@',
  agent: '»',
  plan: '≡',
  other: '•',
}

const COLORS: Record<Kind, string> = {
  read: 'suggestion',
  edit: 'warning',
  run: 'bashBorder',
  search: 'ide',
  web: 'merged',
  agent: 'planMode',
  plan: 'success',
  other: 'inactive',
}

const STATUS: Record<Status, { glyph: string; color: string }> = {
  running: { glyph: '◌', color: 'claude' },
  ok: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
  denied: { glyph: '⊘', color: 'warning' },
}

type Args = Record<string, unknown>

export const register: Register = on => {
  // Playback runs off one ticker; these mirror the stored values for it.
  let playing = false
  let rate = 1
  let elapsed = 0
  let cwd = ''
  let counter = 0

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    playing = false
    rate = await read($, speed)
    await update($, isPlaying, () => false)
    await $.command.register({
      name: 'replay',
      description: 'Open Replay Theater: play back this session tool call by tool call',
    })
    if (!(await read($, isClosed))) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    $.clock.every(TICK_MS, () => {
      if (!playing) {
        return
      }
      elapsed += TICK_MS
      if (elapsed < SCENE_MS / rate) {
        return
      }
      elapsed = 0
      void (async () => {
        const total = (await read($, scenes)).length
        const at = await read($, cursor)
        if (at < 0 || at >= total - 1) {
          playing = false
          await update($, isPlaying, () => false)
        } else {
          await update($, cursor, n => n + 1)
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'replay' }, async $ => {
    await update($, isClosed, () => false)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Replay Theater opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    playing = false
    await update($, isPlaying, () => false)
    if (e.origin.kind === 'person') {
      await update($, isClosed, () => true)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const found = await adopt($, await read($, cast), agentId)
      if (found !== null) {
        await update($, cast, list => join(list, found))
      }
      await update($, cast, list =>
        list.map(c => (c.id === agentId ? { ...c, state: 'running', endedAt: null } : c)),
      )

      return next(e)
    }
    if (e.text !== '' || (await read($, acts)).length === 0) {
      const at = await $.clock.now()
      await update($, acts, list => [...list, { n: list.length + 1, prompt: clip(e.text, 300), at }])
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    const id = ran.agentId
    if (id !== undefined) {
      const member: Cast = {
        id,
        type: e.isTeammate === true ? (e.name ?? 'teammate') : e.subagentType,
        description: e.description,
        parentId: e.parentAgentId ?? null,
        state: 'running',
        startedAt: await $.clock.now(),
        endedAt: null,
      }
      await update($, cast, list => join(list, member))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const state: AgentState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      const endedAt = await $.clock.now()
      await update($, cast, list => list.map(c => (c.id === agentId ? { ...c, state, endedAt } : c)))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const members = await read($, cast)
      if (!members.some(c => c.id === agentId)) {
        const found = await adopt($, members, agentId)
        if (found === null) {
          return next(e)
        }
        await update($, cast, list => join(list, found))
      }
    }
    const at = await $.clock.now()
    let act = (await read($, acts)).length
    if (act === 0) {
      await update($, acts, list => (list.length === 0 ? [{ n: 1, prompt: '', at }] : list))
      act = 1
    }
    counter += 1
    const id = `${e.tool_use_id || 'call'}-${counter}`
    const scene: Scene = { ...staged(e, cwd), id, act, at, durationMs: null, status: 'running' }
    let dropped = 0
    await update($, scenes, list => {
      const grown = [...list, scene]
      dropped = Math.max(0, grown.length - MAX_SCENES)

      return grown.slice(dropped)
    })
    if (dropped > 0) {
      await update($, cursor, n => (n > 0 ? Math.max(0, n - dropped) : n))
    }

    const ran = await next(e)
    const durationMs = (await $.clock.now()) - at
    const done = finished(scene, ran, durationMs)
    await update($, scenes, list => list.map(one => (one.id === id ? done : one)))

    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      playing = false
      await update($, scenes, () => [])
      await update($, acts, () => [])
      await update($, cast, () => [])
      await update($, cursor, () => -1)
      await update($, isPlaying, () => false)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Code, Text } = ui
    // Graphical surfaces draw the lanes as a timeline; the terminal keeps its cells.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, scenes)
    const allActs = await read($, acts)
    const members = await read($, cast)
    const at = await read($, cursor)
    const isRolling = await read($, isPlaying)
    const pace = await read($, speed)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">Replay Theater</Text>
          <Text dimColor>
            Nothing to replay yet. Every tool call Claude makes becomes a scene; each prompt opens a
            new act. Come back here to play the session back.
          </Text>
        </Box>
      )
    }

    const isLive = at < 0 || at >= list.length
    const index = isLive ? list.length - 1 : at
    const scene = list[index] ?? list[list.length - 1]
    if (scene === undefined) {
      return <Text dimColor>Nothing to replay yet.</Text>
    }
    const act = allActs.find(a => a.n === scene.act)
    const firstOf = (n: number) => list.findIndex(s => s.act === n)
    const actIndices = list.flatMap((s, i) => (s.act === scene.act ? [i] : []))
    const actStart = list[actIndices[0] ?? index]?.at ?? scene.at
    const actNumbers = [...new Set(list.map(s => s.act))]
    const actPos = actNumbers.indexOf(scene.act)
    const prevAct = actNumbers[actPos - 1]
    const nextAct = actNumbers[actPos + 1]
    const status = STATUS[scene.status]
    const sceneLane = laneOf(scene)
    const sceneAgent = sceneLane === null ? undefined : members.find(c => c.id === sceneLane)

    const goto = (target: number) => async () => {
      playing = false
      await update($, isPlaying, () => false)
      await update($, cursor, () => target)
    }
    const step = (by: number) => async () => {
      playing = false
      await update($, isPlaying, () => false)
      const total = (await read($, scenes)).length
      await update($, cursor, n => {
        const from = n < 0 || n >= total ? total - 1 : n
        const to = from + by

        return to >= total ? -1 : Math.max(0, to)
      })
    }
    const togglePlay = async () => {
      if (playing) {
        playing = false
        await update($, isPlaying, () => false)

        return
      }
      const total = (await read($, scenes)).length
      const now = await read($, cursor)
      if (now < 0 || now >= total - 1) {
        // From live or the last scene, the current act plays from its start.
        await update($, cursor, () => Math.max(0, actIndices[0] ?? 0))
      }
      playing = true
      elapsed = 0
      await update($, isPlaying, () => true)
    }
    const cycleSpeed = () =>
      update($, speed, n => {
        const following = SPEEDS[(SPEEDS.indexOf(n) + 1) % SPEEDS.length] ?? 1
        rate = following

        return following
      })

    // The filmstrip: one cell per scene around the one on stage, a bar between acts.
    // Once agents have worked, it splits into swimlanes: the main loop, then one per agent.
    const hasAgents = list.some(s => laneOf(s) !== null)
    const room = Math.max(10, e.props.bodyColumns - 2 - (hasAgents ? LANE_LABEL : 0))
    const from = Math.max(0, Math.min(index - Math.floor(room / 2), list.length - room))
    const strip = list.slice(from, from + room)
    const lanes = hasAgents ? laneIdsOf(strip) : [null]
    const shownLanes = lanes.slice(0, MAX_LANES)
    const kinds = [...new Set(strip.map(s => s.kind))]
    const latestOf = (id: string) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (laneOf(list[i]) === id) {
          return i
        }
      }

      return -1
    }

    const scriptFrom = Math.max(
      0,
      Math.min(actIndices.indexOf(index) - Math.floor(SCRIPT_WINDOW / 2), actIndices.length - SCRIPT_WINDOW),
    )
    const script = actIndices.slice(scriptFrom, scriptFrom + SCRIPT_WINDOW)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="claude" weight="bold">
            ACT {actPos + 1}
          </Text>
          <Text dimColor>of {actNumbers.length}</Text>
          <Text italic wrap="truncate-end">
            {act === undefined || act.prompt === '' ? '(before the first prompt)' : `“${clip(oneLine(act.prompt), 120)}”`}
          </Text>
        </Box>

        <Box flexDirection="row" gap={1} marginTop={1}>
          {sceneLane !== null && (
            <Text color="planMode" weight="semibold">
              ⧉ {laneLabel(members, sceneLane)}
            </Text>
          )}
          <Text color={COLORS[scene.kind]} weight="semibold">
            {ICONS[scene.kind]} {scene.title}
          </Text>
          <Text weight="semibold" wrap="truncate-end">
            {scene.subject}
          </Text>
          <Box flexGrow={1} />
          <Text color={status.color} tabular>
            {status.glyph} {scene.durationMs === null ? 'running' : duration(scene.durationMs)}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          Scene {index + 1} of {list.length} · +{duration(scene.at - actStart)} into the act
          {isLive ? ' · ● LIVE' : ''}
          {scene.detail !== '' && scene.detail !== scene.subject ? ` · ${scene.detail}` : ''}
        </Text>
        {sceneAgent !== undefined && sceneAgent.description !== '' && (
          <Text dimColor wrap="truncate-end">
            Agent task: {sceneAgent.description}
          </Text>
        )}

        {scene.diff !== null && (
          <Box marginTop={1}>
            <Code format="diff" source={scene.diff} wrap="truncate-end" />
          </Box>
        )}
        {scene.code !== null && (
          <Box marginTop={1}>
            <Code
              source={scene.code}
              wrap="truncate-end"
              {...(scene.codeLanguage === null ? {} : { language: scene.codeLanguage })}
              {...(scene.codePath === null ? {} : { path: scene.codePath })}
            />
          </Box>
        )}
        {scene.output !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{scene.status === 'ok' ? 'Output' : scene.status === 'denied' ? 'Denied' : 'Error'}</Text>
            <Code source={scene.output} wrap="truncate-end" />
          </Box>
        )}

        {Svg !== null ? (
          <Box marginTop={1}>
            <Svg {...timelineSvg(list, actIndices, index, members, e.props.bodyColumns)} isInteractive />
          </Box>
        ) : (
        <Box flexDirection="column" marginTop={1}>
          {shownLanes.map(id => (
            <Text mono wrap="truncate-end">
              {hasAgents && (
                <Text
                  color={id === null ? 'claude' : 'planMode'}
                  weight={id === sceneLane ? 'bold' : 'regular'}
                  dimColor={id !== sceneLane}
                >
                  {pad(id === null ? 'Main' : `${CAST_STATES[stateOf(members, id)].glyph} ${laneLabel(members, id)}`, LANE_LABEL)}
                </Text>
              )}
              {laneCells(strip, from, index, id, id !== null && stateOf(members, id) === 'running').map(cell => (
                <Text color={cell.color} dimColor={cell.isDim}>
                  {cell.text}
                </Text>
              ))}
            </Text>
          ))}
          {lanes.length > MAX_LANES && <Text dimColor>… {lanes.length - MAX_LANES} more agents in view</Text>}
          <Text dimColor wrap="truncate-end">
            {hasAgents ? ' '.repeat(LANE_LABEL) : ''}
            {kinds.map(kind => (
              <Text>
                <Text color={COLORS[kind]}>▮</Text> {kind}{'  '}
              </Text>
            ))}
          </Text>
        </Box>
        )}

        {hasAgents && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor weight="semibold">
              Cast
            </Text>
            {shownLanes.flatMap(id => {
              const member = id === null ? undefined : members.find(c => c.id === id)
              if (id === null || member === undefined) {
                return []
              }
              const look = CAST_STATES[member.state]
              const count = list.filter(s => laneOf(s) === id).length
              const took = (member.endedAt ?? list[list.length - 1]?.at ?? member.startedAt) - member.startedAt

              return [
                <Button key={`c:${id}`} plain dimColor={id !== sceneLane} onPress={goto(latestOf(id))}>
                  <Text color={look.color}>{look.glyph}</Text> <Text color="planMode">{laneLabel(members, id)}</Text>{' '}
                  {clip(member.description, 48)}{' '}
                  <Text dimColor>
                    · {count} {count === 1 ? 'scene' : 'scenes'} · {look.verb}
                    {member.state === 'running' ? '' : ` in ${duration(Math.max(0, took))}`}
                  </Text>
                </Button>,
              ]
            })}
          </Box>
        )}

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="first" label="⏮" hotkey="g" onPress={goto(0)} />
          <Button key="prev" label="◀ Prev" hotkey="h" onPress={step(-1)} />
          <Button
            key="play"
            label={isRolling ? '⏸ Pause' : '▶ Play'}
            variant="primary"
            hotkey="p"
            onPress={togglePlay}
          />
          <Button key="next" label="Next ▶" hotkey="l" onPress={step(1)} />
          <Button key="live" label="Live ⏭" hotkey="e" variant={isLive ? 'primary' : 'secondary'} onPress={goto(-1)} />
          <Button key="speed" label={`${pace}×`} hotkey="s" onPress={cycleSpeed} />
        </Box>

        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor weight="semibold">
            Script
          </Text>
          <Box flexGrow={1} />
          {prevAct !== undefined && <Button key="act-prev" label="◀ Act" hotkey="k" plain onPress={goto(firstOf(prevAct))} />}
          {nextAct !== undefined && <Button key="act-next" label="Act ▶" hotkey="j" plain onPress={goto(firstOf(nextAct))} />}
        </Box>
        {scriptFrom > 0 && <Text dimColor>  … {scriptFrom} earlier</Text>}
        {script.map(i => {
          const s = list[i]
          if (s === undefined) {
            return null
          }

          return (
            <Button key={`s:${s.id}`} plain dimColor={i !== index} onPress={goto(i)}>
              {i === index ? '▶ ' : '  '}
              {laneOf(s) !== null && <Text color="planMode">{laneLabel(members, laneOf(s) ?? '')} </Text>}
              <Text color={COLORS[s.kind]}>{ICONS[s.kind]}</Text> {s.title} {clip(s.subject, 60)}{' '}
              <Text color={STATUS[s.status].color}>{STATUS[s.status].glyph}</Text>
            </Button>
          )
        })}
        {scriptFrom + script.length < actIndices.length && (
          <Text dimColor>  … {actIndices.length - scriptFrom - script.length} more</Text>
        )}
      </Box>
    )
  })
}

type Staged = Pick<
  Scene,
  'tool' | 'kind' | 'title' | 'subject' | 'detail' | 'diff' | 'code' | 'codePath' | 'codeLanguage' | 'output' | 'isSubagent' | 'agentId'
>

// What a scene shows from the call alone, before the tool answers.
function staged(e: ToolCallInput, cwd: string): Staged {
  const tool = String(e.tool)
  const args = e as unknown as Args
  const file = text(args.file_path) || text(args.notebook_path)
  const shown = file === '' ? '' : relative(cwd, file)
  const scene = (kind: Kind, title: string, subject: string, extra: Partial<Staged> = {}): Staged => ({
    tool,
    kind,
    title,
    subject,
    detail: shown,
    diff: null,
    code: null,
    codePath: null,
    codeLanguage: null,
    output: null,
    isSubagent: e.agentId !== undefined,
    agentId: e.agentId ?? null,
    ...extra,
  })

  switch (tool) {
    case 'Read':
      return scene('read', 'Read', base(file), { codePath: file })
    case 'Edit':
      return scene('edit', 'Edit', base(file), {
        diff: diffOf([[text(args.old_string), text(args.new_string)]]),
      })
    case 'MultiEdit': {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const pairs = edits.map(one => {
        const pair = (typeof one === 'object' && one !== null ? one : {}) as Args

        return [text(pair.old_string), text(pair.new_string)] as [string, string]
      })

      return scene('edit', 'Edit', base(file), { diff: diffOf(pairs) })
    }
    case 'Write':
      return scene('edit', 'Write', base(file), {
        code: lines(text(args.content), MAX_CODE_LINES),
        codePath: file,
      })
    case 'NotebookEdit':
      return scene('edit', 'Notebook', base(file), {
        code: lines(text(args.new_source), MAX_CODE_LINES),
        codeLanguage: 'python',
      })
    case 'Bash':
    case 'PowerShell': {
      const command = text(args.command)

      return scene('run', tool, clip(oneLine(text(args.description) || command), 80), {
        detail: '',
        code: lines(command, MAX_CODE_LINES),
        codeLanguage: tool === 'Bash' ? 'bash' : 'powershell',
      })
    }
    case 'Grep':
      return scene('search', 'Grep', text(args.pattern), { detail: text(args.path) })
    case 'Glob':
      return scene('search', 'Glob', text(args.pattern), { detail: text(args.path) })
    case 'WebSearch':
      return scene('web', 'Search', text(args.query))
    case 'WebFetch':
      return scene('web', 'Fetch', text(args.url))
    case 'Agent':
    case 'Task':
      return scene('agent', 'Agent', text(args.description), {
        code: lines(text(args.prompt), MAX_CODE_LINES),
        codeLanguage: 'markdown',
      })
    case 'TodoWrite':
      return scene('plan', 'Plan', 'Updated the plan', { code: checklist(args.todos) })
    // A cloud session keeps its plan with the task tools, one task per call.
    case 'TaskCreate':
      return scene('plan', 'Plan', `Added: ${clip(oneLine(text(args.subject)), 80)}`)
    case 'TaskUpdate': {
      const change = text(args.status) || (text(args.subject) ? `renamed to ${clip(oneLine(text(args.subject)), 60)}` : 'updated')

      return scene('plan', 'Plan', `Task ${text(args.taskId)}: ${change}`)
    }
  }
  if (tool.endsWith('__update_plan')) {
    return scene('plan', 'Plan', 'Updated the plan', {
      code: Array.isArray(args.items) ? checklist(args.items) : planMove(args),
    })
  }
  if (tool.endsWith('__wrap_up')) {
    return scene('plan', 'Wrap-up', clip(oneLine(text(args.recap)), 80))
  }
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'tool' && key !== 'tool_use_id' && key !== 'agentId'),
  )
  const json = lines(JSON.stringify(rest, null, 2) ?? '{}', MAX_CODE_LINES)
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = tool] = tool.split('__')

    return scene('other', name, clip(server, 40), { code: json, codeLanguage: 'json' })
  }

  return scene('other', tool, '', { code: json, codeLanguage: 'json' })
}

// The scene once the tool answered: its status and what came back.
function finished(scene: Scene, ran: ToolCallResult, durationMs: number): Scene {
  if (ran.deny !== undefined) {
    return { ...scene, durationMs, status: 'denied', output: lines(ran.deny, MAX_OUTPUT_LINES) }
  }
  const said = typeof ran.text === 'string' ? ran.text : ''
  if (ran.isError === true) {
    return { ...scene, durationMs, status: 'error', output: lines(said || 'The tool reported an error.', MAX_OUTPUT_LINES) }
  }
  const record = (typeof ran.result === 'object' && ran.result !== null ? ran.result : {}) as Args
  const patch = patchDiff(record.structuredPatch)
  if (scene.kind === 'edit') {
    // The tool's own patch carries real line numbers; prefer it to the call's strings.
    return patch === null ? { ...scene, durationMs, status: 'ok' } : { ...scene, durationMs, status: 'ok', diff: patch, code: null }
  }
  const room = scene.kind === 'read' || scene.kind === 'search' || scene.kind === 'web' ? 20 : MAX_OUTPUT_LINES

  return { ...scene, durationMs, status: 'ok', output: said === '' ? null : lines(said, room) }
}

function patchDiff(patch: unknown): string | null {
  if (!Array.isArray(patch) || patch.length === 0) {
    return null
  }
  const hunks = patch.flatMap(one => {
    const h = (typeof one === 'object' && one !== null ? one : {}) as Args
    const body = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : []
    const oldStart = typeof h.oldStart === 'number' ? h.oldStart : 1
    const newStart = typeof h.newStart === 'number' ? h.newStart : 1

    return body.length === 0 ? [] : [{ oldStart, newStart, body }]
  })

  return hunks.length === 0 ? null : joinHunks(hunks)
}

function diffOf(pairs: [string, string][]): string | null {
  const hunks = pairs
    .filter(([a, b]) => a !== '' || b !== '')
    .map(([a, b]) => ({
      oldStart: 1,
      newStart: 1,
      body: [...(a === '' ? [] : a.split('\n').map(l => `-${l}`)), ...(b === '' ? [] : b.split('\n').map(l => `+${l}`))],
    }))

  return hunks.length === 0 ? null : joinHunks(hunks)
}

// Hunks cut to the line budget, each header counted from the lines kept, so a cut diff still parses.
function joinHunks(hunks: { oldStart: number; newStart: number; body: string[] }[]): string {
  let budget = MAX_DIFF_LINES
  const out: string[] = []
  for (const hunk of hunks) {
    const body = hunk.body.filter(l => /^[ +-]/.test(l)).slice(0, budget)
    if (body.length === 0) {
      break
    }
    budget -= body.length
    const olds = body.filter(l => l[0] !== '+').length
    const news = body.filter(l => l[0] !== '-').length
    out.push(`@@ -${hunk.oldStart},${olds} +${hunk.newStart},${news} @@`, ...body.map(l => clip(l, 400)))
  }

  return out.join('\n')
}

function checklist(items: unknown): string | null {
  if (!Array.isArray(items)) {
    return null
  }
  const marks: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }

  return items
    .map(item => {
      const one = (typeof item === 'object' && item !== null ? item : {}) as Args

      return `${marks[text(one.status)] ?? '[ ]'} ${text(one.content)}`
    })
    .join('\n')
}

function planMove(args: Args): string | null {
  const moves: string[] = []
  if (args.advance === true) {
    moves.push('Finished the current step, started the next')
  }
  if (Array.isArray(args.done)) {
    moves.push(`Marked done: ${args.done.join(', ')}`)
  }
  if (typeof args.start === 'number') {
    moves.push(`Started step ${args.start}`)
  }

  return moves.length === 0 ? null : moves.join('\n')
}

function lines(value: string, max: number): string {
  const all = value.length > MAX_TEXT ? value.slice(0, MAX_TEXT).split('\n') : value.split('\n')
  const kept = all.slice(0, max)
  const more = value.split('\n').length - kept.length

  return more > 0 ? `${kept.join('\n')}\n… ${more} more lines` : kept.join('\n')
}

function duration(ms: number) {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const total = Math.floor(ms / 1000)

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function relative(cwd: string, path: string) {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = path.replace(/\\/g, '/')
  const head = p.slice(0, root.length)
  const isInside = root !== '' && head.toLowerCase() === root.toLowerCase() && p[root.length] === '/'

  return isInside ? p.slice(root.length + 1) : p
}

function base(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function oneLine(value: string) {
  return value.split('\n')[0] ?? ''
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function laneOf(scene: Scene | undefined): string | null {
  return scene?.agentId ?? null
}

// The lanes a stretch of scenes touches: the main loop first, then agents as they first act.
function laneIdsOf(strip: Scene[]): (string | null)[] {
  const ids: (string | null)[] = [null]
  for (const scene of strip) {
    const id = laneOf(scene)
    if (id !== null && !ids.includes(id)) {
      ids.push(id)
    }
  }

  return ids
}

// An agent's name on its lane: its type, numbered when several of a type worked.
function laneLabel(members: Cast[], id: string): string {
  const member = members.find(c => c.id === id)
  if (member === undefined) {
    return 'agent'
  }
  const sameType = members.filter(c => c.type === member.type)

  return sameType.length > 1 ? `${member.type} ${sameType.indexOf(member) + 1}` : member.type
}

function stateOf(members: Cast[], id: string): AgentState {
  return members.find(c => c.id === id)?.state ?? 'done'
}

type Cell = { text: string; color: string; isDim: boolean }

// One lane's cells: its scenes coloured by kind, a lifeline while the agent is on stage, the stage's column marked.
function laneCells(strip: Scene[], from: number, index: number, id: string | null, isRunning: boolean): Cell[] {
  const mine = strip.flatMap((s, i) => (laneOf(s) === id ? [i] : []))
  const first = id === null ? -1 : (mine[0] ?? strip.length)
  const last = id === null || isRunning ? strip.length : (mine[mine.length - 1] ?? -1)
  const cells: Cell[] = []
  strip.forEach((s, i) => {
    const pos = from + i
    if (i > 0 && strip[i - 1]?.act !== s.act) {
      cells.push({ text: '│', color: 'inactive', isDim: true })
    }
    if (laneOf(s) === id) {
      cells.push(
        pos === index
          ? { text: '◆', color: 'claude', isDim: false }
          : { text: s.status === 'error' ? '✗' : '▮', color: s.status === 'error' ? 'error' : COLORS[s.kind], isDim: pos > index },
      )
    } else if (pos === index) {
      cells.push({ text: '┊', color: 'claude', isDim: true })
    } else {
      cells.push({ text: i > first && i < last ? '─' : ' ', color: 'inactive', isDim: true })
    }
  })

  // Neighbours of one look draw as one run.
  return cells.reduce<Cell[]>((runs, cell) => {
    const prev = runs[runs.length - 1]
    if (prev !== undefined && prev.color === cell.color && prev.isDim === cell.isDim) {
      runs[runs.length - 1] = { ...prev, text: prev.text + cell.text }
    } else {
      runs.push(cell)
    }

    return runs
  }, [])
}

function join(list: Cast[], member: Cast): Cast[] {
  if (!list.some(c => c.id === member.id)) {
    return [...list, member].slice(-MAX_CAST)
  }
  const { id, type, description, parentId } = member

  return list.map(c => (c.id === id ? { ...c, type, description, parentId } : c))
}

// An agent the cast lacks (its first call raced its spawn, or the mod reloaded), looked up in the session's list.
async function adopt($: EngineInterface, members: Cast[], id: string): Promise<Cast | null> {
  if (strangers.has(id) || members.some(c => c.id === id)) {
    return null
  }
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) {
    strangers.add(id)

    return null
  }

  return {
    id,
    type: info.type,
    description: info.description,
    parentId: info.parentId ?? null,
    state: 'running',
    startedAt: await $.clock.now(),
    endedAt: null,
  }
}

function pad(value: string, width: number) {
  const cut = clip(value, width - 1)

  return cut + ' '.repeat(Math.max(1, width - cut.length))
}

// Fixed colours for the timeline, readable on a dark or a light pane.
const HEX: Record<Kind, string> = {
  read: '#60a5fa',
  edit: '#f59e0b',
  run: '#f472b6',
  search: '#22d3ee',
  web: '#a78bfa',
  agent: '#c084fc',
  plan: '#4ade80',
  other: '#9ca3af',
}
const MUTED = '#8b919c'
const TICKS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]

// The act on stage as a timeline: a lane per loop, each tool call a bar from its start for as long as it ran.
function timelineSvg(list: Scene[], indices: number[], index: number, members: Cast[], columns: number) {
  const act = indices.flatMap(i => {
    const scene = list[i]

    return scene === undefined ? [] : [{ scene, i }]
  })
  const lanes = laneIdsOf(act.map(x => x.scene)).slice(0, MAX_LANES)
  const width = Math.round(Math.min(900, Math.max(280, columns * 7.5)))
  const labelW = 108
  const trackW = width - labelW - 8
  const axisH = 18
  const rowH = 22
  const height = axisH + lanes.length * rowH + 22
  const t0 = Math.min(...act.map(x => x.scene.at))
  const t1 = Math.max(t0 + 1000, ...act.map(x => x.scene.at + (x.scene.durationMs ?? 0)))
  const span = t1 - t0
  const xOf = (t: number) => (labelW + ((t - t0) / span) * trackW).toFixed(1)
  const bottom = axisH + lanes.length * rowH
  const parts: string[] = []

  const step = (TICKS_S.find(s => span / (s * 1000) <= 5) ?? 3600) * 1000
  for (let k = 0; k * step <= span; k++) {
    const x = xOf(t0 + k * step)
    parts.push(
      `<line x1="${x}" y1="${axisH - 4}" x2="${x}" y2="${bottom}" stroke="${MUTED}" stroke-opacity="0.18"/>`,
      `<text x="${x}" y="${axisH - 7}" font-size="10" fill="${MUTED}" text-anchor="${k === 0 ? 'start' : 'middle'}">${escapeXml(duration(k * step))}</text>`,
    )
  }

  lanes.forEach((id, row) => {
    const cy = axisH + row * rowH + rowH / 2
    const mine = act.filter(x => laneOf(x.scene) === id)
    const member = id === null ? undefined : members.find(c => c.id === id)
    const label = id === null ? 'Main' : `${CAST_STATES[stateOf(members, id)].glyph} ${laneLabel(members, id)}`
    const isStage = mine.some(x => x.i === index)
    const isRunning = member?.state === 'running'
    const lastEnd = Math.max(t0, ...mine.map(x => x.scene.at + (x.scene.durationMs ?? 0)))
    const from = id === null ? t0 : Math.max(t0, member?.startedAt ?? mine[0]?.scene.at ?? t0)
    const until = id === null || isRunning ? t1 : Math.min(t1, Math.max(lastEnd, member?.endedAt ?? lastEnd))
    parts.push(
      `<text x="4" y="${cy + 4}" font-size="11" font-weight="${isStage ? 700 : 500}" fill="${id === null ? '#d97757' : '#a78bfa'}">${escapeXml(clip(label, 17))}</text>`,
      `<line x1="${xOf(from)}" y1="${cy}" x2="${xOf(until)}" y2="${cy}" stroke="${MUTED}" stroke-opacity="0.5" stroke-width="1.5"${isRunning ? ' stroke-dasharray="3 3"' : ''}/>`,
    )
    for (const { scene, i } of mine) {
      const w = Math.max(3, ((scene.durationMs ?? t1 - scene.at) / span) * trackW)
      const fill = scene.status === 'error' ? '#ef4444' : HEX[scene.kind]
      const ring = i === index ? ` stroke="#d97757" stroke-width="2"` : ''
      const fade = i > index ? ' fill-opacity="0.45"' : ''
      const tip = `${label} · ${scene.title} ${scene.subject} · ${STATUS[scene.status].glyph} ${scene.durationMs === null ? 'running' : duration(scene.durationMs)}`
      parts.push(
        `<rect x="${xOf(scene.at)}" y="${cy - 6}" width="${w.toFixed(1)}" height="12" rx="2" fill="${fill}"${fade}${ring}><title>${escapeXml(tip)}</title></rect>`,
      )
    }
  })

  const stage = list[index]
  if (stage !== undefined && act.some(x => x.i === index)) {
    const x = xOf(stage.at + (stage.durationMs ?? 0) / 2)
    parts.push(`<line x1="${x}" y1="${axisH - 4}" x2="${x}" y2="${bottom}" stroke="#d97757" stroke-width="1.5" stroke-dasharray="2 2"/>`)
  }

  let lx = labelW
  for (const kind of [...new Set(act.map(x => x.scene.kind))]) {
    parts.push(
      `<rect x="${lx}" y="${bottom + 8}" width="9" height="9" rx="2" fill="${HEX[kind]}"/>`,
      `<text x="${lx + 13}" y="${bottom + 16}" font-size="10" fill="${MUTED}">${kind}</text>`,
    )
    lx += 22 + kind.length * 6
  }

  const agents = lanes.filter(id => id !== null).length
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">${parts.join('')}</svg>`

  return {
    source,
    alt: `Timeline of this act: the main loop${agents > 0 ? ` and ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}, ${act.length} tool calls`,
  }
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
