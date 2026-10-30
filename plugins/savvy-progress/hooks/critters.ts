import type { Role } from '../types'

export const ROLE_LABELS: Record<Role, string> = {
  researcher: 'Researcher',
  frontend: 'Frontend',
  backend: 'Backend',
  designer: 'Designer',
  tester: 'Tester',
  planner: 'Planner',
  reviewer: 'Reviewer',
  writer: 'Writer',
  devops: 'DevOps',
  debugger: 'Debugger',
  security: 'Security',
  generalist: 'Generalist',
}

// The agent type alone says this much about the role.
const TYPE_HINTS: [RegExp, Role][] = [
  [/explore/i, 'researcher'],
  [/plan/i, 'planner'],
  [/review/i, 'reviewer'],
  [/test/i, 'tester'],
  [/design/i, 'designer'],
  [/front/i, 'frontend'],
  [/back/i, 'backend'],
  [/doc|writ/i, 'writer'],
  [/secur/i, 'security'],
  [/debug/i, 'debugger'],
  [/ops|deploy/i, 'devops'],
]

// Words in the task that point at a role.
const CUES: [Role, RegExp][] = [
  ['tester', /\b(tests?|testing|specs?|qa|verif(y|ies|ication)|coverage|e2e|regressions?|assertions?)\b/gi],
  [
    'designer',
    /\b(design(s|ing|er)?|ux|mockups?|figma|logos?|icons?|graphics?|visuals?|palettes?|typography|branding|illustrations?|animations?|styles?)\b/gi,
  ],
  [
    'frontend',
    /\b(front-?end|react|vue|svelte|angular|css|html|tailwind|components?|pages?|landing|layouts?|ui|client|browser|dom|tsx|jsx|forms?|buttons?|screens?)\b/gi,
  ],
  [
    'backend',
    /\b(back-?end|apis?|servers?|databases?|db|sql|postgres|schemas?|endpoints?|migrations?|queues?|redis|graphql|rest|services?|webhooks?)\b/gi,
  ],
  [
    'researcher',
    /\b(research\w*|investigat\w*|explor\w*|find|finding|search\w*|look(ing)? up|survey\w*|compar\w*|competitors?|analy[sz]\w*|study|discover\w*|audit\w*|inventor(y|ies)|trace|tracing|explain\w*|map(ping)?|understand\w*)\b/gi,
  ],
  ['planner', /\b(plan(s|ning)?|architect\w*|roadmaps?|strateg\w*|outline\w*|breakdown|scope|scoping|estimat\w*|proposals?)\b/gi],
  ['reviewer', /\b(review\w*|critique\w*|feedback|lint\w*|inspect\w*|proofread\w*)\b/gi],
  [
    'writer',
    /\b(docs?|documentation|readme|copy(writing)?|blog|articles?|changelog|summar\w*|draft\w*|announcements?|emails?|write-?ups?)\b/gi,
  ],
  [
    'devops',
    /\b(deploy\w*|ci|cd|pipelines?|docker\w*|kubernetes|k8s|infra\w*|terraform|releas\w*|ship(ping)?|devops|monitoring|builds?)\b/gi,
  ],
  ['debugger', /\b(debug\w*|bugs?|fix(es|ing)?|crash\w*|errors?|failing|broken|stack ?trace|issues?)\b/gi],
  ['security', /\b(secur\w*|vulnerab\w*|permissions?|secrets?|xss|csrf|injection|pentest\w*|threats?|cves?|auth\w*)\b/gi],
]

// The role an agent plays: its type's hint, then the words of its task (the description counts double).
export function roleOf(type: string, description: string, prompt: string): Role {
  const score = new Map<Role, number>()
  const add = (role: Role, n: number) => score.set(role, (score.get(role) ?? 0) + n)
  for (const [hint, role] of TYPE_HINTS) {
    if (hint.test(type)) {
      add(role, 3)
    }
  }
  for (const [role, cue] of CUES) {
    add(role, 2 * (description.match(cue)?.length ?? 0))
    add(role, Math.min(3, prompt.slice(0, 600).match(cue)?.length ?? 0))
  }
  let best: Role = 'generalist'
  let top = 0
  for (const [role, n] of score) {
    if (n > top) {
      best = role
      top = n
    }
  }

  return best
}

const INK: Record<string, string> = {
  K: '#2b1d18',
  Y: '#facc15',
  y: '#fef08a',
  // Inks bright enough to read on a dark pane: amber rather than brown, slate rather than charcoal.
  B: '#b45309',
  k: '#c8a165',
  w: '#f3f4f6',
  d: '#64748b',
  s: '#cbd5e1',
  L: '#a1a1aa',
  l: '#71717a',
  g: '#93c5fd',
  G: '#22c55e',
  m: '#86efac',
  c: '#22d3ee',
  R: '#ef4444',
  P: '#ec4899',
  b: '#3b82f6',
  n: '#4338ca',
  // The debugger's bug alone is purple, so it stands out.
  v: '#a855f7',
  x: '#111111',
}

// A run of pixels: its row, the column it starts at, and one ink per pixel ('.' skips one).
type Stroke = [row: number, column: number, inks: string]

// A part that moves while the agent works: it shows for the steps of `frames` marked 1.
// A resting part is drawn, still, when the agent is not working.
type Motion = { strokes: Stroke[]; frames: string; seconds: number; isRest?: boolean }

type Look = { strokes: Stroke[]; motions?: Motion[] }

// The critter itself, on an 18 by 12 grid, the same for every role; its eyes sit at row 7, columns 6 and 11.
const BODY: Stroke[] = [
  [6, 4, 'oooooooooo'],
  [7, 4, 'ooKooooKoo'],
  [8, 3, 'oooKooooKooo'],
  [9, 3, 'oooooooooooo'],
  [10, 4, 'oooooooooo'],
  [11, 4, 'o.o....o.o'],
]

const EYES: [number, number][] = [
  [7, 6],
  [7, 11],
]

// Two frames that take turns: the first rests, the second steps in.
const swap = (seconds: number, first: Stroke[], second: Stroke[]): Motion[] => [
  { strokes: first, frames: '10', seconds, isRest: true },
  { strokes: second, frames: '01', seconds },
]

// A laptop at the critter's side; the screen is the role's to fill.
const LAPTOP: Stroke[] = [
  [8, 12, 'LLLLL'],
  [9, 12, 'L...L'],
  [10, 12, 'L...L'],
  [11, 11, 'llllll'],
]

// Each role's headgear and prop, drawn over the body, and what moves while it works; 'h' is the card's colour.
const LOOKS: Record<Role, Look> = {
  // A scientist: wild white hair, goggles up on the forehead, a lab coat and a bubbling flask.
  researcher: {
    strokes: [
      [3, 5, 'w.w..w.w'],
      [4, 4, 'wwwwwwwwww'],
      [5, 3, 'wdggddddggdw'],
      [9, 4, 'w.........w'],
      [10, 4, 'ww......ww'],
      [6, 15, 'ss'],
      [7, 15, 'ss'],
      [8, 14, 'sGGs'],
      [9, 14, 'GGGG'],
      [10, 14, 'ssss'],
    ],
    motions: swap(0.7, [[5, 15, 'm'], [3, 16, 'm']], [[4, 16, 'm'], [2, 15, 'm']]),
  },
  // A developer in a red backwards cap, at a laptop whose page keeps changing.
  frontend: {
    strokes: [[3, 8, 'x'], [4, 5, 'RRRRRRRR'], [5, 1, 'RRRRRRRRRRRRR'], ...LAPTOP],
    motions: swap(0.8, [[9, 13, 'Pww'], [10, 13, 'bbw']], [[9, 13, 'wcY'], [10, 13, 'wPP']]),
  },
  // A developer in headphones, at a laptop with a terminal and a blinking cursor.
  backend: {
    strokes: [
      [4, 5, 'dddddddd'],
      [5, 4, 'd........d'],
      [6, 3, 'bb'],
      [7, 3, 'bb'],
      [6, 13, 'bb'],
      [7, 13, 'bb'],
      ...LAPTOP,
      [9, 13, 'mmx'],
      [10, 13, 'mxx'],
    ],
    motions: [{ strokes: [[10, 14, 'm']], frames: '10', seconds: 1 }],
  },
  // An artist: a tilted beret, a palette and a brush whose tip changes colour.
  designer: {
    strokes: [
      [3, 8, 'P'],
      [4, 4, 'PPPPPPPP'],
      [5, 2, 'PPPPPPPPPPP'],
      [9, 0, 'kRk'],
      [10, 0, 'bkY'],
      [6, 16, 's'],
      [7, 15, 'B'],
      [8, 15, 'B'],
      [9, 14, 'B'],
    ],
    motions: [
      { strokes: [[4, 16, 'P'], [5, 16, 'P']], frames: '100', seconds: 2.4, isRest: true },
      { strokes: [[4, 16, 'b'], [5, 16, 'b']], frames: '010', seconds: 2.4 },
      { strokes: [[4, 16, 'Y'], [5, 16, 'Y']], frames: '001', seconds: 2.4 },
    ],
  },
  // QA in a hard hat and goggles, holding up a check that now and then turns to a cross.
  tester: {
    strokes: [
      [4, 6, 'YYYYYY'],
      [5, 3, 'YYYYYYYYYYYY'],
      [7, 4, 'dgKgddgKgd'],
      [2, 14, 'wwww'],
      [3, 14, 'wwwG'],
      [4, 14, 'GwGw'],
      [5, 14, 'wGww'],
      [6, 15, 'B'],
      [7, 15, 'B'],
      [8, 15, 'B'],
      [9, 15, 'B'],
    ],
    motions: [{ strokes: [[2, 14, 'RwwR'], [3, 14, 'wRRw'], [4, 14, 'wRRw'], [5, 14, 'RwwR']], frames: '0001', seconds: 3.2 }],
  },
  // A graduate's mortarboard with a swinging tassel, and a rolled blueprint.
  planner: {
    strokes: [
      [3, 2, 'dddddddddddd'],
      [4, 5, 'dddddd'],
      [5, 4, 'dddddddddd'],
      [8, 14, 'wnnn'],
      [9, 14, 'wnwn'],
      [10, 14, 'wnnn'],
    ],
    motions: swap(0.9, [[4, 13, 'Y'], [5, 13, 'Y']], [[4, 13, 'Y'], [5, 14, 'Y']]),
  },
  // A bowler hat and glasses, ticking off a clipboard; the glasses catch the light.
  reviewer: {
    strokes: [
      [3, 6, 'dddddd'],
      [4, 5, 'dRRRRRRd'],
      [5, 3, 'dddddddddddd'],
      [7, 5, 'sKssssKs'],
      [7, 15, 'xx'],
      [8, 14, 'kwwk'],
      [9, 14, 'kwwk'],
      [10, 14, 'kwwk'],
      [11, 14, 'kkkk'],
    ],
    motions: [
      { strokes: [[8, 15, 'G']], frames: '0111', seconds: 3, isRest: true },
      { strokes: [[9, 15, 'G']], frames: '0011', seconds: 3, isRest: true },
      { strokes: [[10, 15, 'G']], frames: '0001', seconds: 3 },
      { strokes: [[7, 5, 'w']], frames: '00001', seconds: 2.5 },
    ],
  },
  // A newsboy cap and a quill that writes line after line.
  writer: {
    strokes: [
      [3, 8, 'B'],
      [4, 5, 'BBBBBBBB'],
      [5, 4, 'BBBBBBBBBBBB'],
      [8, 13, 'wwww'],
      [9, 13, 'wwww'],
      [10, 13, 'wwww'],
      [11, 13, 'wwww'],
      [9, 13, 'xxx'],
    ],
    motions: [
      ...swap(
        0.5,
        [[3, 17, 'w'], [4, 16, 'ww'], [5, 15, 'ww'], [6, 15, 'w'], [7, 14, 'x']],
        [[3, 17, 'w'], [4, 16, 'ww'], [5, 16, 'ww'], [6, 16, 'w'], [7, 15, 'x']],
      ),
      { strokes: [[10, 13, 'xx']], frames: '011', seconds: 3, isRest: true },
      { strokes: [[11, 13, 'xxx']], frames: '001', seconds: 3 },
    ],
  },
  // A captain's cap and a rocket on a flickering flame.
  devops: {
    strokes: [
      [3, 5, 'wwwwwwww'],
      [4, 4, 'wwwwwwwwww'],
      [5, 4, 'nnnnYnnnnn'],
      [0, 15, 'R'],
      [1, 14, 'www'],
      [2, 14, 'wbw'],
      [3, 14, 'www'],
      [4, 13, 'RwwwR'],
    ],
    motions: swap(0.3, [[5, 15, 'Y'], [6, 15, 'R']], [[5, 14, 'yYy'], [6, 15, 'Y'], [7, 15, 'R']]),
  },
  // A headlamp that flares, and the bug it is hunting, legs scuttling.
  debugger: {
    strokes: [[4, 8, 'ss'], [5, 4, 'ddddYYdddd'], [8, 15, 'vv'], [9, 14, 'vRRv'], [10, 14, 'vvvv']],
    motions: [
      { strokes: [[5, 8, 'ww'], [4, 7, 'y'], [4, 10, 'y'], [3, 8, 'yy']], frames: '0001', seconds: 1.6 },
      ...swap(0.4, [[11, 14, 'v..v']], [[11, 15, 'vv']]),
    ],
  },
  // A knight's helmet with a plume, eyes glowing through the slit, and a shield a glint runs across.
  security: {
    strokes: [
      [3, 6, 'ssssss'],
      [4, 5, 'ssssssss'],
      [5, 4, 'ssssssssss'],
      [6, 4, 'ssssssssss'],
      [7, 4, 'sxwxxxxwxs'],
      [8, 4, 'ssssssssss'],
      [6, 14, 'bbbb'],
      [7, 14, 'bnYb'],
      [8, 14, 'bYYb'],
      [9, 14, 'bnnb'],
      [10, 15, 'bb'],
    ],
    motions: [
      ...swap(1.1, [[1, 9, 'RR'], [2, 8, 'RR']], [[1, 10, 'RR'], [2, 9, 'RR']]),
      { strokes: [[6, 14, 'w']], frames: '1000000', seconds: 2.8 },
      { strokes: [[7, 15, 'w']], frames: '0100000', seconds: 2.8 },
      { strokes: [[8, 16, 'w']], frames: '0010000', seconds: 2.8 },
    ],
  },
  // A cap in the card's colour and a toolbox, with dots that show it thinking.
  generalist: {
    strokes: [[4, 5, 'hhhhhhhh'], [5, 4, 'hhhhhhhhhhhhh'], [9, 15, 'xx'], [10, 14, 'RRRR'], [11, 14, 'RYRR']],
    motions: [
      { strokes: [[3, 14, 'w']], frames: '0111', seconds: 2 },
      { strokes: [[2, 15, 'w']], frames: '0011', seconds: 2 },
      { strokes: [[1, 16, 'w']], frames: '0001', seconds: 2 },
    ],
  },
}

const PIXEL = 3

function pixels(strokes: Stroke[], fills: Record<string, string>): Map<string, string> {
  const cells = new Map<string, string>()
  for (const [row, column, inks] of strokes) {
    ;[...inks].forEach((ink, i) => {
      if (ink !== '.') {
        cells.set(`${column + i},${row}`, fills[ink] ?? ink)
      }
    })
  }

  return cells
}

function rects(cells: Map<string, string>): string {
  return [...cells]
    .map(([at, fill]) => {
      const [x = 0, y = 0] = at.split(',').map(Number)

      return `<rect x="${x * PIXEL + 1}" y="${y * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${fill}"/>`
    })
    .join('')
}

// Shows a group only on the steps of `frames` marked 1, one step after another.
function steps(frames: string, seconds: number): string {
  return `<animate attributeName="opacity" values="${[...frames].join(';')}" dur="${seconds}s" calcMode="discrete" repeatCount="indefinite"/>`
}

// A pixel critter dressed for its role. While the agent works it bobs, blinks and its prop moves;
// otherwise it stands still, greyed out if the agent failed.
export function critterSvg(role: Role, accent: string, isRunning: boolean, isFailed: boolean): string {
  const body = isFailed ? '#9ca3af' : '#d97757'
  const fills: Record<string, string> = { ...INK, o: body, h: accent }
  const look = LOOKS[role]
  const still = pixels([...BODY, ...look.strokes], fills)
  const motions = (look.motions ?? []).filter(m => isRunning || m.isRest === true)
  let drawn = rects(still)
  for (const m of motions) {
    const part = rects(pixels(m.strokes, fills))
    drawn += isRunning ? `<g opacity="${m.frames[0]}">${steps(m.frames, m.seconds)}${part}</g>` : part
  }
  if (isRunning) {
    // A blink now and then, where the role leaves the eyes showing.
    const lids = new Map(EYES.filter(([r, c]) => still.get(`${c},${r}`) === INK.K).map(([r, c]) => [`${c},${r}`, body]))
    if (lids.size > 0) {
      drawn += `<g opacity="0">${steps('0000000001', 4)}${rects(lids)}</g>`
    }
    drawn = `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="1.4s" repeatCount="indefinite"/>${drawn}</g>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 36" width="56" height="36" shape-rendering="crispEdges">${drawn}</svg>`
}
