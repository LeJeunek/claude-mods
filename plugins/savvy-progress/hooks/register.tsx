import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, ToolCallInput, TurnUsage } from 'claude-code'

import type { AgentCall, AgentLive, AgentState, CallStatus, Kind, Outcome, PlanStep, Progress, StepStatus } from '../types'
import { critterSvg, ROLE_LABELS, roleOf } from './critters'

const progress = atom({ plugin: 'savvy-progress', key: 'progress' } as const, null)
const isHidden = atom({ plugin: 'savvy-progress', key: 'isHidden' } as const, false)
const isExpanded = atom({ plugin: 'savvy-progress', key: 'isExpanded' } as const, false)
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const agentsClosed = atom({ plugin: 'savvy-progress', key: 'agentsClosed' } as const, false)
const openCards = atom({ plugin: 'savvy-progress', key: 'openCards' } as const, [])
const openTiles = atom({ plugin: 'savvy-progress', key: 'openTiles' } as const, [])

const AGENTS_PANE = 'agents'
const AGENTS_TITLE = 'Agents'

// Durations of past answered turns, kept across sessions to learn the person's pace.
const HISTORY = 'durations'
// The same per agent type (Explore, Plan, ...), to estimate how far along an agent is.
const AGENT_HISTORY = 'agentDurations'
const HISTORY_SIZE = 30
const MIN_SAMPLES = 3

// The panel keeps this session's agents; the band shows only the running and the recent.
const MAX_AGENTS = 40
const TRAIL = 8
// Finished agents stay on the band this long into later turns.
const RECENT_MS = 5 * 60_000
// Each agent's call log, and how much of it an open Tools list shows.
const MAX_CALLS = 40
const SHOWN_CALLS = 12
const SHOWN_DONE = 12
// What the band's overview lists of the turn: its latest calls and changed files.
const SHOWN_ACTIONS = 4
const SHOWN_FILES = 6
// The band's left column holds each line's glyph, so the text of every line starts at the same place.
const GUTTER = 2
// The narrowest an overview tile gets before the grid puts fewer to a row.
const TILE_MIN = 30

const CALL_LOOKS: Record<CallStatus, { glyph: string; color: string }> = {
  running: { glyph: '◌', color: 'claude' },
  ok: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
  denied: { glyph: '⊘', color: 'warning' },
}

const SPIN = ['◐', '◓', '◑', '◒']

// Agent card colours, in spawn order: amber, blue, green, violet, pink, cyan.
const PALETTE = ['#d4a72c', '#3b82f6', '#22a06b', '#a855f7', '#ec4899', '#06b6d4']

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

const OUTCOMES: Record<Outcome, { glyph: string; color: string; verb: string }> = {
  answer: { glyph: '✓', color: 'success', verb: 'Done in' },
  aborted: { glyph: '■', color: 'warning', verb: 'Stopped after' },
  error: { glyph: '✗', color: 'error', verb: 'Hit an error after' },
  refusal: { glyph: '✗', color: 'error', verb: 'Declined after' },
}

const AGENT_ENDS: Record<Exclude<AgentState, 'running'>, { glyph: string; color: string; verb: string }> = {
  done: { glyph: '✓', color: 'success', verb: 'finished' },
  failed: { glyph: '✗', color: 'error', verb: 'failed' },
  stopped: { glyph: '■', color: 'warning', verb: 'stopped' },
}

const EFFORT_WORDS: Record<string, string> = {
  low: 'light',
  medium: 'medium',
  high: 'careful',
  xhigh: 'thorough',
  max: 'all-out',
}

// Dollars per million tokens. Cache writes are priced at 1.25x input.
const PRICES: [RegExp, { input: number; output: number; cacheRead: number }][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
]

// Loop ids the session's agent list never named: the engine's own forks (memory, compaction).
const strangers = new Set<string>()

type Args = Record<string, unknown>
type Look = { kind: Kind; activity: string; target: string; path: string | null; isChange: boolean }

export const register: Register = on => {
  // The session's folder, so changed files show by their path inside it.
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'agents-panel',
      description: 'Show the Agents panel: what each subagent is doing, its cost and progress',
    })
    await $.command.register({
      name: 'progress',
      description: 'Show the progress bar again (add "expand" to open it up)',
    })
    // The clock runs while anything works, and on until the last finished agent has aged off the band.
    $.clock.every(1000, () => {
      void (async () => {
        const p = await read($, progress)
        const t = await $.clock.now()
        const isShowingAgents = (a: AgentLive) =>
          a.state === 'running' || (a.endedAt !== null && t - a.endedAt <= RECENT_MS)
        if (p !== null && (p.isWorking || agentsOf(p).some(isShowingAgents))) {
          await update($, now, () => t)
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await update($, agentsClosed, () => false)
    await $.ui.open({ id: AGENTS_PANE, title: AGENTS_TITLE })

    return { text: 'Agents panel opened.' }
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    await update($, isHidden, () => false)
    if (e.args.trim() === 'expand') {
      await update($, isExpanded, () => true)
    }

    return { text: 'Progress bar shown.' }
  })

  on('ui.close', { id: AGENTS_PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, agentsClosed, () => true)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    const agentId = e.agentId
    if (agentId !== undefined) {
      // A subagent or teammate starting (or resuming) a run of its loop.
      const found = await adopt($, await read($, progress), agentId)
      if (found !== null) {
        await update($, progress, p => upsertAgent(p ?? fresh(at, []), found))
      }
      await update($, progress, p =>
        patchAgent(p, agentId, a => ({
          ...a,
          state: 'running',
          endedAt: null,
          activity: a.state === 'running' ? a.activity : 'Resuming',
        })),
      )

      return next(e)
    }
    const typicalMs = median(await history($))
    await update($, progress, p => ({
      ...fresh(at, keptPlan(p)),
      typicalMs,
      prompt: e.text === '' ? (p?.prompt ?? '') : e.text,
      // The session's agents carry over: the panel lists them all, the band the recent ones.
      agents: p === null ? [] : agentsOf(p),
    }))
    await update($, now, () => at)
    await update($, isHidden, () => false)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    const id = ran.agentId
    if (id !== undefined) {
      const at = await $.clock.now()
      const type = e.isTeammate === true ? (e.name ?? 'teammate') : e.subagentType
      const typicalMs = median((await agentHistory($))[type] ?? [])
      await update($, progress, p => {
        const live = p ?? fresh(at, [])
        const agent: AgentLive = {
          ...newAgent(id, at),
          parentId: e.parentAgentId ?? null,
          type,
          description: e.description,
          isBackground: e.background,
          model: ran.model,
          color: nextColor(agentsOf(live)),
          typicalMs,
          group: live.prompt ?? '',
          role: roleOf(type, e.description, e.prompt),
        }

        return upsertAgent(live, agent)
      })
      await update($, now, () => at)
      if (!(await read($, agentsClosed))) {
        void $.ui.open({ id: AGENTS_PANE, title: AGENTS_TITLE }).catch(() => undefined)
      }
    }

    return ran
  })

  // Each model request of an agent's loop: which model and effort it runs on, and what it cost.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, progress, p => patchAgent(p, agentId, a => ({ ...a, model: e.model, effort: effort ?? a.effort ?? null })))
    }
    const response = yield* next(e)
    const usage = response.usage
    if (agentId !== undefined && usage !== null) {
      await update($, progress, p => patchAgent(p, agentId, a => charge(a, usage)))
    }

    return response
  })

  on('tool.call', async ($, e, next) => {
    const look = describe(e)
    const startedAt = await $.clock.now()
    const agentId = e.agentId
    const tool = String(e.tool)
    const call: AgentCall = {
      id: `${e.tool_use_id}:${startedAt}`,
      tool,
      kind: look.kind,
      target: look.target,
      status: 'running',
      startedAt,
      durationMs: null,
    }
    // A Write to a path that was not there makes a new file, marked A rather than M.
    const isCreate =
      tool === 'Write' && look.path !== null && !(await $.fs.exists(look.path).catch(() => true))

    if (agentId !== undefined) {
      const found = await adopt($, await read($, progress), agentId)
      if (found !== null) {
        await update($, progress, p => upsertAgent(p ?? fresh(startedAt, []), found))
      }
      await update($, progress, p =>
        patchAgent(p, agentId, a => ({
          ...a,
          tools: a.tools + 1,
          running: a.running + 1,
          activity: look.activity,
          kind: look.kind,
          trail: [...a.trail, look.kind].slice(-TRAIL),
          calls: [...(a.calls ?? []), call].slice(-MAX_CALLS),
          toolCounts: { ...a.toolCounts, [tool]: (a.toolCounts?.[tool] ?? 0) + 1 },
        })),
      )
      const ran = await next(e)
      const hasFailed = ran.deny !== undefined || ran.isError === true
      const status: CallStatus = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
      const durationMs = (await $.clock.now()) - startedAt
      await update($, progress, p =>
        patchAgent(p, agentId, a => {
          const running = Math.max(0, a.running - 1)
          const isIdle = running === 0 && a.state === 'running'

          return {
            ...a,
            running,
            activity: isIdle ? 'Thinking' : a.activity,
            kind: isIdle ? 'other' : a.kind,
            steps: hasFailed ? a.steps : planAfter(tool, e as unknown as Args, a.steps ?? []),
            calls: (a.calls ?? []).map(one => (one.id === call.id ? { ...one, status, durationMs } : one)),
          }
        }),
      )
      // Files an agent changed count among the turn's changed files too.
      if (look.isChange && !hasFailed && look.path !== null) {
        const path = look.path
        await update($, progress, p => (p === null ? p : withFileChange(p, path, isCreate)))
      }

      return ran
    }

    await update($, progress, p => {
      const live = p ?? fresh(startedAt, [])
      if (!live.isWorking) {
        return p
      }

      return {
        ...live,
        tools: live.tools + 1,
        running: live.running + 1,
        activity: look.activity,
        kind: look.kind,
        actions: [...(live.actions ?? []), call].slice(-MAX_CALLS),
        toolCounts: { ...live.toolCounts, [tool]: (live.toolCounts?.[tool] ?? 0) + 1 },
      }
    })

    const ran = await next(e)
    const hasFailed = ran.deny !== undefined || ran.isError === true
    const status: CallStatus = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const durationMs = (await $.clock.now()) - startedAt
    await update($, progress, p => {
      if (p === null || !p.isWorking) {
        return p
      }
      const running = Math.max(0, p.running - 1)
      const path = look.path
      const changed = look.isChange && !hasFailed && path !== null ? withFileChange(p, path, isCreate) : p

      return {
        ...changed,
        running,
        failures: p.failures + (hasFailed ? 1 : 0),
        plan: hasFailed ? p.plan : planAfter(tool, e as unknown as Args, p.plan),
        activity: running === 0 ? 'Thinking' : p.activity,
        kind: running === 0 ? 'other' : p.kind,
        actions: (p.actions ?? []).map(one => (one.id === call.id ? { ...one, status, durationMs } : one)),
      }
    })

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()
    const agentId = e.agentId
    if (agentId !== undefined) {
      const state: AgentState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      const usage = e.usage
      await update($, progress, p =>
        patchAgent(p, agentId, a => {
          // Where no step reported usage, the turn's own sum stands in.
          const charged = (a.tokens ?? 0) === 0 && usage !== undefined ? charge(a, usage) : a

          return { ...charged, state, endedAt, running: 0, activity: '' }
        }),
      )
      const agent = agentsOf((await read($, progress)) ?? fresh(endedAt, [])).find(a => a.id === agentId)
      if (agent !== undefined && state === 'done') {
        const past = await agentHistory($)
        const runs = [...(past[agent.type] ?? []), endedAt - agent.startedAt].slice(-HISTORY_SIZE)
        await $.store.set(AGENT_HISTORY, { ...past, [agent.type]: runs })
      }

      return next(e)
    }
    const p = await read($, progress)
    if (p !== null && p.isWorking) {
      await update($, progress, () => ({
        ...p,
        isWorking: false,
        endedAt,
        running: 0,
        outcome: e.reason,
        outputTokens: e.usage?.output_tokens ?? null,
      }))
      if (e.reason === 'answer') {
        const past = await history($)
        await $.store.set(HISTORY, [...past, endedAt - p.startedAt].slice(-HISTORY_SIZE))
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, progress, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const p = await read($, progress)
    if (p === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await read($, now)
    const seconds = Math.floor(Math.max(0, t - p.startedAt) / 1000)
    // Agents at work, and those that finished a moment ago; the panel has the rest.
    const agents = agentsOf(p).filter(a => a.state === 'running' || (a.endedAt !== null && t - a.endedAt < RECENT_MS))
    const busy = agents.filter(a => a.state === 'running')
    const hide = (
      <Button
        key="hide"
        label="Hide"
        role="dismiss"
        plain
        dimColor
        onPress={() => update($, isHidden, () => true)}
      />
    )
    const open = await read($, isExpanded)
    const expand = (
      <Button
        key="expand"
        label={open ? '▾ Less' : '▸ More'}
        plain
        dimColor
        onPress={() => update($, isExpanded, v => !v)}
      />
    )

    // Opened up: the plan's steps, then a brief account of the turn's actions, its tools and the files it changed.
    const counts = Object.entries(p.toolCounts ?? {}).sort(([, x], [, y]) => y - x)
    const latestActions = [...(p.actions ?? [])].reverse().slice(0, SHOWN_ACTIONS)
    const created = new Set(p.filesCreated ?? [])
    const tilesOpen = await read($, openTiles)
    const allActions = [...(p.actions ?? [])].reverse()
    // A grid row: fixed-width cells so every row lines up on any surface.
    const cell = (width: number, child: RenderChildren, isRight = false) => (
      <Box width={width} flexShrink={0} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
        {child}
      </Box>
    )
    // A line under the header, its text in line with the header's.
    const indented = (child: RenderChildren) => (
      <Box flexDirection="row">
        <Box width={GUTTER} flexShrink={0} />
        <Box flexGrow={1}>{child}</Box>
      </Box>
    )
    // The tiles sit on a grid: as many to a row as fit, the rows evened out, every column the same width.
    const tileCount = 2 + (p.plan.length > 0 ? 1 : 0) + (agents.length > 0 ? 1 : 0)
    const fits = Math.max(1, Math.floor((e.props.bodyColumns + 1) / (TILE_MIN + 1)))
    const perRow = Math.ceil(tileCount / Math.ceil(tileCount / fits))
    const tileWidth = `${Math.floor(100 / perRow)}%`
    // One tile of the overview: a title that opens it, a one-line summary, and its rows once open.
    const tile = (id: string, title: string, count: string, summary: RenderChildren, rows: RenderChildren) => {
      const isTileOpen = tilesOpen.includes(id)

      return (
        <Box flexDirection="column" width={tileWidth} flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row">
            <Button
              key={`tile:${id}`}
              plain
              onPress={() => update($, openTiles, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))}
            >
              {isTileOpen ? '▾' : '▸'} {title}
            </Button>
            <Box flexGrow={1} />
            <Text dimColor tabular>
              {count}
            </Text>
          </Box>
          {summary}
          {isTileOpen && rows}
        </Box>
      )
    }
    const doneSteps = countDone(p.plan)
    const tiles: RenderChildren[] = !open
      ? []
      : [
          p.plan.length > 0 &&
          tile(
            'steps',
            'Steps',
            `${doneSteps}/${p.plan.length}`,
            <Text wrap="truncate-end" dimColor>
              {currentStep(p.plan)?.content ?? 'all done'}
            </Text>,
            <Box flexDirection="column">
              {p.plan.map((s, i) => (
                <Box flexDirection="row">
                  {cell(
                    2,
                    <Text color={s.status === 'completed' ? 'success' : s.status === 'in_progress' ? 'claude' : 'inactive'}>
                      {s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◐' : '○'}
                    </Text>,
                  )}
                  {cell(3, <Text dimColor>{i + 1}.</Text>)}
                  <Box flexGrow={1}>
                    <Text wrap="truncate-end" dimColor={s.status === 'completed'}>
                      {s.content}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>,
          ),
          tile(
          'tools',
          'Tools',
          `${p.tools} ${p.tools === 1 ? 'call' : 'calls'}`,
          counts.length === 0 ? (
            <Text dimColor>none yet</Text>
          ) : (
            <Text wrap="truncate-end">
              {counts.map(([tool, n], i) => (
                <Text>
                  {i > 0 ? <Text dimColor> · </Text> : ''}
                  <Text color={COLORS[kindOfTool(tool)]}>{toolName(tool)}</Text>
                  <Text dimColor> ×{n}</Text>
                </Text>
              ))}
            </Text>
          ),
          <Box flexDirection="column">
            {allActions.slice(0, SHOWN_CALLS).map(action => (
              <Box flexDirection="row">
                {cell(2, <Text color={CALL_LOOKS[action.status].color}>{CALL_LOOKS[action.status].glyph}</Text>)}
                {cell(
                  10,
                  <Text color={COLORS[action.kind]} wrap="truncate-end">
                    {toolName(action.tool)}
                  </Text>,
                )}
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">{action.target === '' ? '—' : action.target}</Text>
                </Box>
                {cell(
                  8,
                  <Text dimColor tabular>
                    {action.status === 'running' ? callTime(t - action.startedAt) : callTime(action.durationMs ?? 0)}
                  </Text>,
                  true,
                )}
              </Box>
            ))}
            {allActions.length > SHOWN_CALLS && <Text dimColor>… {allActions.length - SHOWN_CALLS} earlier</Text>}
          </Box>,
        ),
          tile(
          'files',
          'Files',
          `${p.filesChanged.length} changed`,
          <Text dimColor wrap="truncate-end">
            {p.filesChanged.length === 0
              ? 'none changed'
              : `${created.size} new · ${p.filesChanged.length - created.size} modified`}
          </Text>,
          <Box flexDirection="column">
            {p.filesChanged.slice(0, SHOWN_FILES * 3).map(file => (
              <Box flexDirection="row">
                {cell(2, <Text color={created.has(file) ? 'success' : 'warning'}>{created.has(file) ? 'A' : 'M'}</Text>)}
                <Box flexGrow={1}>
                  <Text wrap="truncate-start">{shortPath(cwd, file)}</Text>
                </Box>
              </Box>
            ))}
          </Box>,
        ),
          agents.length > 0 &&
          tile(
            'agents',
            'Agents',
            `${agents.length}`,
            <Text dimColor wrap="truncate-end">
              {tally(agents).replace(/^ · /, '')}
            </Text>,
            <Box flexDirection="column">
              {agents.map(a => (
                <Box flexDirection="row">
                  {cell(
                    2,
                    <Text color={a.state === 'running' ? 'claude' : AGENT_ENDS[a.state].color}>
                      {a.state === 'running' ? '◐' : AGENT_ENDS[a.state].glyph}
                    </Text>,
                  )}
                  {cell(
                    12,
                    <Text color="planMode" wrap="truncate-end">
                      {ROLE_LABELS[a.role ?? roleOf(a.type, a.description, '')]}
                    </Text>,
                  )}
                  <Box flexGrow={1}>
                    <Text wrap="truncate-end" dimColor={a.state !== 'running'}>
                      {a.state === 'running' ? a.activity : a.description}
                    </Text>
                  </Box>
                  {cell(5, <Text dimColor tabular>{a.tools}×</Text>, true)}
                </Box>
              ))}
            </Box>,
          ),
        ].filter(x => x !== false)
    // Row by row; a short last row is padded out so its tiles keep the columns above.
    const overview =
      tiles.length === 0 ? null : (
        <Box flexDirection="column">
          {Array.from({ length: Math.ceil(tiles.length / perRow) }, (_, r) => {
            const row = tiles.slice(r * perRow, (r + 1) * perRow)

            return (
              <Box flexDirection="row" gap={1}>
                {row}
                {Array.from({ length: perRow - row.length }, () => (
                  <Box width={tileWidth} flexGrow={1} />
                ))}
              </Box>
            )
          })}
        </Box>
      )

    // One line for the agents; their cards live in the Agents panel.
    const roster = agents.length === 0 ? null : (
      <Box flexDirection="row">
        {cell(GUTTER, <Text color="planMode">⧉</Text>)}
        <Box flexDirection="row" flexGrow={1} gap={1}>
          <Text wrap="truncate-end">
            <Text color="planMode" weight="semibold">
              Agents
            </Text>
            <Text dimColor>
              {tally(agents)}
              {busy.map(a => ` · ${ROLE_LABELS[a.role ?? roleOf(a.type, a.description, '')]}: ${a.activity}`).join('')}
            </Text>
          </Text>
          <Box flexGrow={1} />
          <Button
            key="agents-open"
            label="Open panel"
            plain
            dimColor
            onPress={async () => {
              await update($, agentsClosed, () => false)
              await $.ui.open({ id: AGENTS_PANE, title: AGENTS_TITLE })
            }}
          />
        </Box>
      </Box>
    )

    if (p.isWorking) {
      const elapsed = Math.max(0, t - p.startedAt)
      const guess = estimate(p, elapsed)
      const width = Math.max(8, Math.min(28, e.props.bodyColumns - 52))
      const bar = drawBar(guess.pct, width, seconds)
      const step = currentStep(p.plan)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {cell(GUTTER, <Text color="claude">{SPIN[seconds % SPIN.length]}</Text>)}
            <Box flexDirection="row" flexGrow={1} gap={1}>
              <Text weight="semibold">Working</Text>
              <Text tabular>{clock(elapsed)}</Text>
              <Text mono>
                <Text color="claude">{bar.filled}</Text>
                <Text dimColor>{bar.empty}</Text>
              </Text>
              <Text dimColor tabular>
                {guess.label}
              </Text>
              <Box flexGrow={1} />
              {expand}
              {hide}
            </Box>
          </Box>
          {overview}
          {!open &&
            step !== null &&
            indented(
              <Text wrap="truncate-end">
                <Text dimColor>
                  Step {step.index} of {p.plan.length} ·{' '}
                </Text>
                {step.content}
              </Text>,
            )}
          {indented(
            <Text dimColor wrap="truncate-end">
              Now: <Text color={COLORS[p.kind]}>{p.activity}</Text>
              {stats(p)}
            </Text>,
          )}
          {roster}
        </Box>
      )
    }

    const outcome = OUTCOMES[p.outcome ?? 'answer']
    const took = (p.endedAt ?? p.startedAt) - p.startedAt

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {cell(GUTTER, <Text color={outcome.color}>{outcome.glyph}</Text>)}
          <Box flexDirection="row" flexGrow={1} gap={1}>
            <Text wrap="truncate-end">
              {outcome.verb} <Text tabular>{clock(took)}</Text>
              <Text dimColor>
                {stats(p)}
                {p.plan.length > 0 && ` · ${countDone(p.plan)}/${p.plan.length} steps`}
                {p.outputTokens !== null && ` · ${tokens(p.outputTokens)} tokens out`}
                {p.outcome === 'answer' && pace(took, p.typicalMs)}
              </Text>
            </Text>
            <Box flexGrow={1} />
            {expand}
            {hide}
          </Box>
        </Box>
        {overview}
        {roster}
      </Box>
    )
  })

  // The Agents panel: totals, then a card per agent with its critter, model, step, cost and progress.
  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Graphical surfaces get critters and drawn bars; the terminal draws them in text.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const p = await read($, progress)
    const t = await read($, now)
    const agents = p === null ? [] : agentsOf(p)

    if (agents.length === 0) {
      return (
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            Agents
          </Text>
          <Text dimColor>No agents yet. When Claude hands work to subagents, each one gets a card here.</Text>
        </Box>
      )
    }

    const running = agents.filter(a => a.state === 'running')
    // Finished agents, the latest first.
    const finished = agents
      .filter(a => a.state !== 'running')
      .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
    // The tiles total the latest batch: the agents started under the prompt that started the newest one.
    const latest = agents.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
    const group = latest.group ?? ''
    const batch = agents.filter(a => (a.group ?? '') === group)
    const firstStart = Math.min(...batch.map(a => a.startedAt))
    const lastEnd = batch.some(a => a.state === 'running') ? t : Math.max(...batch.map(a => a.endedAt ?? t))
    const priced = batch.filter(a => typeof a.costUsd === 'number')
    const totalCost = costSum(batch)
    const totalTokens = batch.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
    const sessionTokens = agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
    const barWidth = Math.max(10, e.props.bodyColumns - 12)
    const open = await read($, openCards)
    const toggleTools = (id: string) => () =>
      update($, openCards, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

    const tile = (label: string, value: string) => (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text size="caption" dimColor>
          {label}
        </Text>
        <Text size="heading" weight="bold" tabular>
          {value}
        </Text>
      </Box>
    )

    const card = (a: AgentLive) => {
      const hex = PALETTE[(a.color ?? 0) % PALETTE.length] ?? '#d4a72c'
      const role = a.role ?? roleOf(a.type, a.description, '')
      const isRunning = a.state === 'running'
      const end = a.state === 'running' ? null : AGENT_ENDS[a.state]
      const took = Math.max(0, (a.endedAt ?? t) - a.startedAt)
      const pct = agentPct(a, took)
      const steps = a.steps ?? []
      const step = currentStep(steps)
      const stepLine =
        steps.length > 0
          ? `${countDone(steps)}/${steps.length} · ${step?.content ?? 'wrapping up'}`
          : end === null
            ? `${a.tools} ${a.tools === 1 ? 'tool' : 'tools'} · ${a.activity}`
            : `${end.verb} · ${a.tools} ${a.tools === 1 ? 'tool' : 'tools'}`
      const barColor = a.state === 'failed' ? '#ef4444' : hex
      const spent = typeof a.costUsd === 'number' ? `≈${money(a.costUsd)} · ` : ''
      const seconds = Math.floor(took / 1000)

      return (
        <Box flexDirection="row" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          {Svg !== null ? (
            <Svg
              source={critterSvg(role, hex, isRunning, a.state === 'failed')}
              alt={`${a.type} agent as ${ROLE_LABELS[role]}`}
              width={56}
              height={36}
              isInteractive={isRunning}
            />
          ) : (
            <Text color={hex}>{end === null ? SPIN[seconds % SPIN.length] : end.glyph}</Text>
          )}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" gap={1}>
              <Text weight="semibold" wrap="truncate-end">
                {a.description === '' ? a.type : a.description}
              </Text>
              <Box flexGrow={1} />
              <Text color={end === null ? hex : end.color}>{end === null ? '●' : end.glyph}</Text>
            </Box>
            <Text wrap="truncate-end">
              <Text color={hex}>{effortWord(a.effort)}</Text>
              <Text dimColor>
                {' '}
                {modelName(a.model)}
                {a.effort === null || a.effort === undefined ? '' : ` · ${a.effort}`} · {a.type} as{' '}
              </Text>
              <Text color={hex} weight="semibold">
                {ROLE_LABELS[role]}
              </Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">{stepLine}</Text>
              <Box flexGrow={1} />
              <Text dimColor tabular>
                {spent}
                {clock(took)}
              </Text>
            </Box>
            {Svg !== null ? (
              <Svg
                source={barSvg(pct, barColor)}
                alt={pct === null ? 'working' : `${Math.round(pct * 100)}% done`}
                height={6}
                isInteractive={pct === null}
              />
            ) : (
              <Text mono>
                <Text color={barColor}>{textBar(pct, barWidth, seconds).filled}</Text>
                <Text dimColor>{textBar(pct, barWidth, seconds).empty}</Text>
              </Text>
            )}
            {toolsList(a, hex)}
          </Box>
        </Box>
      )
    }

    // The card's Tools dropdown: a tally by tool, then the latest calls, newest first.
    const toolsList = (a: AgentLive, hex: string) => {
      const calls = a.calls ?? []
      const isOpen = open.includes(a.id)
      const busy = calls.filter(call => call.status === 'running').length
      const counts = Object.entries(a.toolCounts ?? {}).sort(([, x], [, y]) => y - x)
      const recent = [...calls].reverse().slice(0, SHOWN_CALLS)
      const earlier = a.tools - recent.length

      return (
        <Box flexDirection="column">
          <Button key={`tools:${a.id}`} plain dimColor={!isOpen} onPress={toggleTools(a.id)}>
            {isOpen ? '▾' : '▸'} Tools · {a.tools} {a.tools === 1 ? 'call' : 'calls'}
            {busy > 0 ? <Text color={hex}> · {busy} running</Text> : ''}
          </Button>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {counts.length === 0 && <Text dimColor>No tool calls yet.</Text>}
              {counts.length > 0 && (
                <Text wrap="wrap">
                  {counts.map(([tool, n], i) => (
                    <Text>
                      {i > 0 ? <Text dimColor> · </Text> : ''}
                      <Text color={COLORS[kindOfTool(tool)]}>{toolName(tool)}</Text>
                      <Text dimColor> ×{n}</Text>
                    </Text>
                  ))}
                </Text>
              )}
              {recent.map(call => {
                const look = CALL_LOOKS[call.status]

                return (
                  <Box flexDirection="row" gap={1}>
                    <Text color={look.color}>{look.glyph}</Text>
                    <Box width={11}>
                      <Text color={COLORS[call.kind]} wrap="truncate-end">
                        {toolName(call.tool)}
                      </Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text wrap="truncate-end" dimColor={call.status !== 'running'}>
                        {call.target === '' ? '—' : call.target}
                      </Text>
                    </Box>
                    <Text dimColor tabular>
                      {call.status === 'running' ? callTime(t - call.startedAt) : callTime(call.durationMs ?? 0)}
                    </Text>
                  </Box>
                )
              })}
              {earlier > 0 && (
                <Text dimColor>
                  … {earlier} earlier {earlier === 1 ? 'call' : 'calls'}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            Agents
          </Text>
          {group !== '' && (
            <Text dimColor wrap="truncate-end">
              {clip(firstLine(group), 80)}
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {tile('Cost', priced.length === 0 ? '—' : `≈${money(totalCost)}`)}
            {tile('Tokens', totalTokens === 0 ? '—' : tokens(totalTokens))}
            {tile('Time', clock(Math.max(0, lastEnd - firstStart)))}
          </Box>
          {agents.length > batch.length && (
            <Text dimColor wrap="truncate-end">
              This session: {agents.length} agents · ≈{money(costSum(agents))}
              {sessionTokens === 0 ? '' : ` · ${tokens(sessionTokens)} tokens`}
            </Text>
          )}
        </Box>
        {running.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" weight="semibold" dimColor>
              RUNNING · {running.length}
            </Text>
            {running.map(card)}
          </Box>
        )}
        {finished.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" weight="semibold" dimColor>
              DONE · {finished.length}
            </Text>
            {finished.slice(0, SHOWN_DONE).map(card)}
            {finished.length > SHOWN_DONE && (
              <Text dimColor>
                … {finished.length - SHOWN_DONE} earlier {finished.length - SHOWN_DONE === 1 ? 'agent' : 'agents'}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}

function fresh(startedAt: number, plan: PlanStep[]): Progress {
  return {
    isWorking: true,
    startedAt,
    endedAt: null,
    tools: 0,
    running: 0,
    failures: 0,
    activity: 'Thinking',
    kind: 'other',
    filesChanged: [],
    plan,
    typicalMs: null,
    outputTokens: null,
    outcome: null,
    agents: [],
  }
}

function agentsOf(p: Progress): AgentLive[] {
  return p.agents ?? []
}

function newAgent(id: string, at: number): AgentLive {
  return {
    id,
    parentId: null,
    type: 'agent',
    description: '',
    isBackground: false,
    state: 'running',
    activity: 'Starting',
    kind: 'agent',
    tools: 0,
    running: 0,
    trail: [],
    startedAt: at,
    endedAt: null,
  }
}

function nextColor(agents: AgentLive[]): number {
  const taken = agents.filter(a => a.state === 'running').map(a => a.color ?? 0)
  const free = PALETTE.findIndex((_, i) => !taken.includes(i))

  return free >= 0 ? free : agents.length % PALETTE.length
}

// Adds an agent, or takes the spawn's facts into one already seen (its work so far kept).
function upsertAgent(p: Progress, agent: AgentLive): Progress {
  const agents = agentsOf(p)
  if (!agents.some(a => a.id === agent.id)) {
    return { ...p, agents: [...agents, { ...agent, color: agent.color ?? nextColor(agents) }].slice(-MAX_AGENTS) }
  }

  return {
    ...p,
    agents: agents.map(a =>
      a.id === agent.id
        ? {
            ...a,
            parentId: agent.parentId,
            type: agent.type,
            description: agent.description,
            isBackground: agent.isBackground,
            model: agent.model ?? a.model ?? null,
            color: a.color ?? agent.color,
            typicalMs: agent.typicalMs ?? a.typicalMs ?? null,
            group: agent.group ?? a.group,
            role: agent.role ?? a.role,
          }
        : a,
    ),
  }
}

// Changes an agent the roster already holds; ids it never saw spawn (the engine's own forks) are left out.
function patchAgent(p: Progress | null, id: string, change: (a: AgentLive) => AgentLive): Progress | null {
  if (p === null || !agentsOf(p).some(a => a.id === id)) {
    return p
  }

  return { ...p, agents: agentsOf(p).map(a => (a.id === id ? change(a) : a)) }
}

// An agent the roster lacks (its first call raced its spawn, or the mod reloaded), looked up in the session's list.
async function adopt($: EngineInterface, p: Progress | null, id: string): Promise<AgentLive | null> {
  if (strangers.has(id) || (p !== null && agentsOf(p).some(a => a.id === id))) {
    return null
  }
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) {
    strangers.add(id)

    return null
  }
  const agent = newAgent(id, await $.clock.now())

  return {
    ...agent,
    parentId: info.parentId ?? null,
    type: info.type,
    description: info.description,
    group: p?.prompt ?? '',
    role: roleOf(info.type, info.description, ''),
  }
}

function charge(a: AgentLive, usage: TurnUsage): AgentLive {
  const spent =
    usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const cost = costOf(usage)

  return {
    ...a,
    model: usage.model,
    tokens: (a.tokens ?? 0) + spent,
    costUsd: cost === null ? (a.costUsd ?? null) : (a.costUsd ?? 0) + cost,
  }
}

// Notes a changed file once, remembering whether the turn created it.
function withFileChange(p: Progress, path: string, isCreate: boolean): Progress {
  const created = p.filesCreated ?? []

  return {
    ...p,
    filesChanged: p.filesChanged.includes(path) ? p.filesChanged : [...p.filesChanged, path],
    filesCreated: isCreate && !created.includes(path) ? [...created, path] : created,
  }
}

// A file by its path inside the session's folder, or by its last two parts when it lies outside.
function shortPath(cwd: string, path: string) {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = path.replace(/\\/g, '/')
  const head = file.slice(0, root.length)
  if (root !== '' && head.toLowerCase() === root.toLowerCase() && file[root.length] === '/') {
    return file.slice(root.length + 1)
  }
  const parts = file.split('/').filter(part => part !== '')

  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : file
}

function costSum(agents: AgentLive[]) {
  return agents.reduce((sum, a) => sum + (typeof a.costUsd === 'number' ? a.costUsd : 0), 0)
}

function costOf(usage: TurnUsage): number | null {
  const price = PRICES.find(([pattern]) => pattern.test(usage.model))?.[1]
  if (price === undefined) {
    return null
  }

  return (
    (usage.input_tokens * price.input +
      usage.cache_creation_input_tokens * price.input * 1.25 +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  )
}

// How far along an agent is: by its own task list, else by how long agents of its type usually take.
function agentPct(a: AgentLive, took: number): number | null {
  if (a.state !== 'running') {
    return 1
  }
  const steps = a.steps ?? []
  if (steps.length > 0) {
    const isActive = steps.some(step => step.status === 'in_progress')

    return Math.min(1, (countDone(steps) + (isActive ? 0.5 : 0)) / steps.length)
  }
  if (typeof a.typicalMs === 'number' && a.typicalMs > 0) {
    return Math.min(0.95, took / a.typicalMs)
  }

  return null
}

function modelName(model: string | null | undefined) {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model ?? '')
  if (match === null) {
    return model ?? 'model pending'
  }
  const [, family = '', major = '', minor] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)

  return minor === undefined || minor.length > 2 ? `${name} ${major}` : `${name} ${major}.${minor}`
}

function effortWord(effort: string | null | undefined) {
  if (effort === null || effort === undefined) {
    return 'default'
  }

  return EFFORT_WORDS[effort] ?? 'custom'
}

function money(usd: number) {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

// A rounded bar in the agent's colour; with no basis for a guess, a short block sweeps along it.
function barSvg(pct: number | null, color: string): string {
  const track = '<rect width="300" height="6" rx="3" fill="#8b919c" fill-opacity="0.22"/>'
  const fill =
    pct === null
      ? `<rect width="80" height="6" rx="3" fill="${color}"><animate attributeName="x" values="-80;300" dur="1.6s" repeatCount="indefinite"/></rect>`
      : `<rect width="${Math.round(300 * pct)}" height="6" rx="3" fill="${color}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 6" preserveAspectRatio="none">${track}${fill}</svg>`
}

function textBar(pct: number | null, width: number, seconds: number) {
  return drawBar(pct, width, seconds)
}

function tally(agents: AgentLive[]) {
  const count = (state: AgentState) => agents.filter(a => a.state === state).length
  const parts = [
    [count('running'), 'running'],
    [count('done'), 'done'],
    [count('failed'), 'failed'],
    [count('stopped'), 'stopped'],
  ] as const

  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => ` · ${n} ${word}`)
    .join('')
}

// A plan carries into the next turn unless it was finished.
function keptPlan(p: Progress | null): PlanStep[] {
  if (p === null || p.plan.every(step => step.status === 'completed')) {
    return []
  }

  return p.plan
}

async function history($: { store: { get: (key: string) => Promise<unknown> } }) {
  const stored = await $.store.get(HISTORY)

  return Array.isArray(stored) ? stored.filter((n): n is number => typeof n === 'number') : []
}

async function agentHistory($: { store: { get: (key: string) => Promise<unknown> } }) {
  const stored = await $.store.get(AGENT_HISTORY)
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {} as Record<string, number[]>
  }

  return Object.fromEntries(
    Object.entries(stored).map(([type, runs]) => [
      type,
      Array.isArray(runs) ? runs.filter((n): n is number => typeof n === 'number') : [],
    ]),
  ) as Record<string, number[]>
}

function median(list: number[]): number | null {
  if (list.length < MIN_SAMPLES) {
    return null
  }
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function describe(e: ToolCallInput): Look {
  const tool = String(e.tool)
  const args = e as unknown as Args
  const text = (key: string) => {
    const value = args[key]

    return typeof value === 'string' ? value : ''
  }
  const file = text('file_path') || text('notebook_path')
  const look = (kind: Kind, activity: string, target: string, isChange = false): Look => ({
    kind,
    activity,
    target,
    path: file === '' ? null : file,
    isChange,
  })

  switch (tool) {
    case 'Read':
      return look('read', `Reading ${base(file)}`, base(file))
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return look('edit', `Editing ${base(file)}`, base(file), true)
    case 'Write':
      return look('edit', `Writing ${base(file)}`, base(file), true)
    case 'Bash':
    case 'PowerShell': {
      const what = clip(firstLine(text('description') || text('command')), 56)

      return look('run', `Running ${what}`, what)
    }
    case 'Grep':
      return look('search', `Searching for "${clip(text('pattern'), 36)}"`, `"${clip(text('pattern'), 48)}"`)
    case 'Glob':
      return look('search', `Finding ${clip(text('pattern'), 40)}`, clip(text('pattern'), 48))
    case 'WebSearch':
      return look('web', `Searching the web for "${clip(text('query'), 36)}"`, `"${clip(text('query'), 48)}"`)
    case 'WebFetch':
      return look('web', `Reading ${host(text('url'))}`, host(text('url')))
    case 'Agent':
    case 'Task':
      return look('agent', `Delegating: ${clip(text('description'), 44)}`, clip(text('description'), 48))
    case 'TodoWrite':
      return look('plan', 'Updating the plan', 'task list')
  }
  if (tool.endsWith('__update_plan')) {
    return look('plan', 'Updating the plan', 'task list')
  }
  if (tool.endsWith('__wrap_up')) {
    return look('plan', 'Wrapping up', 'recap')
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = tool] = tool.split('__')

    return look('other', `Using ${name} (${clip(server, 16)})`, clip(server, 32))
  }

  return look('other', `Using ${tool}`, '')
}

// A tool's short name: an MCP tool by its own name, without the server's prefix.
function toolName(tool: string) {
  return tool.startsWith('mcp__') ? (tool.split('__')[2] ?? tool) : tool
}

function kindOfTool(tool: string): Kind {
  return describe({ tool, tool_use_id: '' } as unknown as ToolCallInput).kind
}

function callTime(ms: number) {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }

  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms)
}

// Follows the task list Claude keeps: TodoWrite in a terminal, update_plan in the desktop app.
function planAfter(tool: string, args: Args, plan: PlanStep[]): PlanStep[] {
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    return toSteps(args.todos)
  }
  if (tool.endsWith('__wrap_up')) {
    return plan.map(step => ({ ...step, status: 'completed' }))
  }
  if (!tool.endsWith('__update_plan')) {
    return plan
  }
  if (Array.isArray(args.items)) {
    return toSteps(args.items)
  }

  let steps = plan
  if (args.advance === true) {
    const active = steps.findIndex(step => step.status === 'in_progress')
    steps = steps.map((step, i) => (i === active ? { ...step, status: 'completed' } : step))
    const following = steps.findIndex(step => step.status === 'pending')
    steps = steps.map((step, i) => (i === following ? { ...step, status: 'in_progress' } : step))
  }
  if (Array.isArray(args.done)) {
    const done = new Set(args.done.filter((n): n is number => typeof n === 'number'))
    steps = steps.map((step, i) => (done.has(i + 1) ? { ...step, status: 'completed' } : step))
  }
  if (typeof args.start === 'number') {
    const start = args.start
    steps = steps.map((step, i) => (i + 1 === start ? { ...step, status: 'in_progress' } : step))
  }

  return steps
}

function toSteps(list: unknown[]): PlanStep[] {
  return list.flatMap(item => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const { content, status } = item as Args
    const isKnown = status === 'pending' || status === 'in_progress' || status === 'completed'

    return [
      {
        content: typeof content === 'string' ? content : '',
        status: isKnown ? (status as StepStatus) : 'pending',
      },
    ]
  })
}

function currentStep(plan: PlanStep[]): { index: number; content: string } | null {
  const active = plan.findIndex(step => step.status === 'in_progress')
  const index = active >= 0 ? active : plan.findIndex(step => step.status === 'pending')
  const step = plan[index]

  return step === undefined ? null : { index: index + 1, content: step.content }
}

function countDone(plan: PlanStep[]) {
  return plan.filter(step => step.status === 'completed').length
}

// Plan-aware when Claude keeps a task list; otherwise measured against the person's usual turn.
function estimate(p: Progress, elapsed: number): { pct: number | null; label: string } {
  if (p.plan.length > 0) {
    const isActive = p.plan.some(step => step.status === 'in_progress')
    const pct = Math.min(1, (countDone(p.plan) + (isActive ? 0.5 : 0)) / p.plan.length)

    return { pct, label: `${Math.round(pct * 100)}%` }
  }
  if (p.typicalMs !== null && p.typicalMs > 0) {
    const ratio = elapsed / p.typicalMs
    if (ratio > 1) {
      return { pct: 0.95, label: `past your usual ${clock(p.typicalMs)}` }
    }

    return { pct: Math.min(0.95, ratio), label: `est. vs your usual ${clock(p.typicalMs)}` }
  }

  return { pct: null, label: 'learning your pace' }
}

function drawBar(pct: number | null, width: number, seconds: number) {
  if (pct === null) {
    // No basis for a guess yet: a short block sweeps across instead.
    const span = Math.max(3, Math.floor(width / 5))
    const at = seconds % (width - span + 1)

    return { filled: '─'.repeat(at) + '━'.repeat(span), empty: '─'.repeat(width - at - span) }
  }
  const filled = Math.round(pct * width)

  return { filled: '━'.repeat(filled), empty: '─'.repeat(width - filled) }
}

function stats(p: Progress) {
  const parts = [` · ${p.tools} ${p.tools === 1 ? 'tool' : 'tools'}`]
  if (p.filesChanged.length > 0) {
    const n = p.filesChanged.length
    parts.push(` · ${n} ${n === 1 ? 'file' : 'files'} changed`)
  }
  if (p.failures > 0) {
    parts.push(` · ${p.failures} failed`)
  }
  const agents = agentsOf(p).filter(a => a.startedAt >= p.startedAt).length
  if (agents > 0) {
    parts.push(` · ${agents} ${agents === 1 ? 'agent' : 'agents'}`)
  }

  return parts.join('')
}

function pace(took: number, typicalMs: number | null) {
  if (typicalMs === null) {
    return ''
  }
  if (took < typicalMs * 0.6) {
    return ' · quicker than usual'
  }
  if (took > typicalMs * 1.6) {
    return ' · slower than usual'
  }

  return ' · about your usual pace'
}

function clock(ms: number) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function tokens(n: number) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  return n >= 1000 ? `${n >= 100_000 ? Math.round(n / 1000) : (n / 1000).toFixed(1)}k` : String(n)
}

function base(path: string) {
  return path.split(/[\\/]/).pop() || path || 'a file'
}

function firstLine(text: string) {
  return text.split('\n')[0] ?? ''
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function host(url: string) {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url)

  return match?.[1] ?? clip(url, 40)
}
