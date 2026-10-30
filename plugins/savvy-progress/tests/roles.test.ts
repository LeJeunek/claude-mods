import { expect, test } from 'claude-code/testing'

import { critterSvg, ROLE_LABELS, roleOf } from '../hooks/critters'

test('an agent plays the role its type and task point to', () => {
  const cases: [string, string, string][] = [
    ['general-purpose', 'Build the landing page', 'frontend'],
    ['general-purpose', 'Add API endpoints for orders', 'backend'],
    ['Plan', 'Design the launch graphics', 'designer'],
    ['general-purpose', 'Write tests for the login flow', 'tester'],
    ['Explore', 'Research competitor launches', 'researcher'],
    ['Plan', 'Plan the migration roadmap', 'planner'],
    ['general-purpose', 'Review the pull request', 'reviewer'],
    ['general-purpose', 'Update the README and changelog', 'writer'],
    ['general-purpose', 'Deploy the release pipeline', 'devops'],
    ['general-purpose', 'Fix the crash on startup', 'debugger'],
    ['general-purpose', 'Check for XSS vulnerabilities', 'security'],
    ['general-purpose', 'Tidy things up', 'generalist'],
    ['Explore', 'Find auth handlers', 'researcher'],
  ]
  for (const [type, description, role] of cases) {
    expect(`${description}: ${roleOf(type, description, '')}`).toBe(`${description}: ${role}`)
  }
})

test('every role draws its own critter, moving only while the agent works', () => {
  const roles = Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]
  const drawings = new Set(roles.map(role => critterSvg(role, '#3b82f6', false, false)))
  expect(drawings.size).toBe(roles.length)

  // Developers sit at a laptop; the tester wears a hard hat.
  const working = critterSvg('backend', '#3b82f6', true, false)
  expect(working).toContain('viewBox="0 0 56 36"')
  expect(working).toContain('#a1a1aa')
  expect(critterSvg('frontend', '#3b82f6', false, false)).toContain('#a1a1aa')
  expect(critterSvg('tester', '#3b82f6', false, false)).toContain('#facc15')
  // Working: it bobs, blinks and its prop moves. Resting or failed: still, and grey when failed.
  expect(working).toContain('animateTransform')
  expect(critterSvg('researcher', '#3b82f6', true, false)).toContain('calcMode="discrete"')
  expect(critterSvg('researcher', '#3b82f6', false, false)).not.toContain('<animate')
  expect(critterSvg('tester', '#3b82f6', false, true)).toContain('#9ca3af')
})

test('a working critter loops a prop motion of its own, and stands still once done', () => {
  const blink = '0;0;0;0;0;0;0;0;0;1'
  const part = /<g opacity="(\d)"><animate attributeName="opacity" values="([^"]*)" dur="([\d.]+)s" calcMode="discrete" repeatCount="indefinite"\/>/g
  for (const role of Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]) {
    const working = critterSvg(role, '#3b82f6', true, false)
    const parts = [...working.matchAll(part)]
    // Every moving part loops forever, steps between hidden and shown, and starts on its first frame.
    expect(`${role}: ${working.split('<animate ').length - 1} parts`).toBe(`${role}: ${parts.length} parts`)
    for (const [, opacity = '', values = '', seconds = ''] of parts) {
      const isStepping = /^[01](;[01])+$/.test(values) && values.includes('0') && values.includes('1')
      expect(`${role} ${values}: ${isStepping}, ${opacity === values[0]}, ${Number(seconds) > 0}`)
        .toBe(`${role} ${values}: true, true, true`)
    }
    // Besides blinking, its prop moves, and the whole critter bobs once over.
    expect(`${role} prop moves: ${parts.some(p => p[2] !== blink)}`).toBe(`${role} prop moves: true`)
    expect(`${role}: ${working.split('<animateTransform').length - 1} bob`).toBe(`${role}: 1 bob`)
    // Finished or failed, nothing moves.
    expect(critterSvg(role, '#3b82f6', false, false)).not.toContain('<animate')
    expect(critterSvg(role, '#3b82f6', false, true)).not.toContain('<animate')
  }
})
