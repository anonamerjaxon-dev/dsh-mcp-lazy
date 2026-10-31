#!/usr/bin/env node
/**
 * Offline checks for dsh-mcp-lazy.
 *
 * The whole safety argument is in `createServerController`, which takes an
 * injected clock and has no timers of its own — so every timing rule is testable
 * without waiting: idle release, the grace period, "never while running", and
 * "re-open after release".
 *
 *   node test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const M = await import(path.join(here, 'index.js'))

let passed = 0
const check = (label, fn) => {
  try { fn(); passed++; console.log(`  ok   ${label}`) } catch (error) {
    console.error(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/** A controller with a fake clock and recording hooks. */
function harness({ idleMs = 60_000 } = {}) {
  let t = 1_000_000
  const events = []
  const ctrl = M.createServerController({
    serverName: 'demo',
    idleMs,
    async onOpen() { events.push('open'); return { dispose: async () => events.push('dispose') } },
    async onClose(fiber) { await fiber.dispose() },
  }, () => t)
  return { ctrl, events, advance: (ms) => { t += ms }, nowRef: () => t }
}

console.log('\nopening')
{
  const { ctrl, events } = harness()
  check('a fresh controller is closed', () => assert.equal(ctrl.isOpen, false))
}
{
  const { ctrl, events } = harness()
  await ctrl.open()
  check('open marks it open and calls the hook once', () => {
    assert.equal(ctrl.isOpen, true)
    assert.deepEqual(events, ['open'])
  })
  await ctrl.open()
  check('a second open is a no-op, not a second mount', () => {
    assert.deepEqual(events, ['open'])
    assert.equal(ctrl.stats.opens, 1)
  })
}

console.log('\nrelease rules')
{
  const { ctrl, advance } = harness({ idleMs: 60_000 })
  await ctrl.open()
  check('immediately after opening it will not release', () => {
    assert.equal(ctrl.shouldRelease().release, false)
  })
  advance(30_000)
  check('half the grace period is not enough', () => assert.equal(ctrl.shouldRelease().release, false))
  advance(31_000)
  check('past the grace period with nothing running, it releases', () => {
    const v = ctrl.shouldRelease()
    assert.equal(v.release, true)
    assert.match(v.reason, /idle/)
  })
}
{
  const { ctrl, advance } = harness({ idleMs: 60_000 })
  await ctrl.open()
  ctrl.noteRunning()
  advance(600_000)
  check('a running agent blocks release no matter how long it has been', () => {
    const v = ctrl.shouldRelease()
    assert.equal(v.release, false)
    assert.match(v.reason, /running/)
  })
  ctrl.noteIdle()
  check('idle after running restarts the grace period', () => {
    assert.equal(ctrl.shouldRelease().release, false, 'the clock restarted, so it must not release yet')
  })
  advance(61_000)
  check('and then releases once the fresh grace period passes', () => {
    assert.equal(ctrl.shouldRelease().release, true)
  })
}
{
  const { ctrl, advance } = harness({ idleMs: 60_000 })
  await ctrl.open()
  advance(50_000)
  ctrl.touch()
  advance(50_000)
  check('a touch restarts the timer, so steady use never releases', () => {
    assert.equal(ctrl.shouldRelease().release, false)
  })
  advance(20_000)
  check('once use really stops, it releases', () => assert.equal(ctrl.shouldRelease().release, true))
}
{
  const { ctrl } = harness()
  check('a closed controller never reports that it should release', () => {
    assert.equal(ctrl.shouldRelease().release, false)
  })
}

console.log('\nreopening')
{
  const { ctrl, events, advance } = harness({ idleMs: 1_000 })
  await ctrl.open()
  advance(2_000)
  await ctrl.close()
  check('close disposes and clears the open flag', () => {
    assert.equal(ctrl.isOpen, false)
    assert.deepEqual(events, ['open', 'dispose'])
  })
  await ctrl.open()
  check('it can reopen after release', () => {
    assert.equal(ctrl.isOpen, true)
    assert.equal(ctrl.stats.opens, 2)
  })
  check('opens and closes are counted separately', () => {
    assert.equal(ctrl.stats.closes, 1)
  })
}
{
  const { ctrl } = harness()
  check('closing a closed controller is harmless', () => {
    assert.doesNotThrow(() => ctrl.close())
  })
}

console.log('\nfailure handling')
{
  let t = 0
  let attempts = 0
  const ctrl = M.createServerController({
    serverName: 'bad',
    idleMs: 1000,
    async onOpen() { attempts += 1; throw new Error('spawn failed') },
  }, () => t)
  const result = await ctrl.open()
  check('a failing open resolves with ok:false and names the reason', () => {
    assert.equal(result.ok, false)
    assert.match(result.reason, /spawn failed/)
  })
  check('a failed open leaves the server closed', () => {
    assert.equal(ctrl.isOpen, false, 'a failed open must not look open')
  })
  check('state is consistent after the failure', () => {
    assert.equal(ctrl.stats.opens, 0, 'a failed attempt is not a successful open')
    assert.equal(attempts, 1)
  })
  const retry = await ctrl.open()
  check('it can be retried after a failure', () => {
    assert.equal(retry.ok, false)
    assert.equal(attempts, 2, 'the retry really tried again')
  })
}

console.log('\nresolution')
check('the MCP client resolves from the host install, not the profile', () => {
  const p = M.resolveMcpClient()
  assert.ok(p.includes('dsh-mcp-client'), p)
  assert.ok(p.includes('lib/index.js'), p)
})
check('the plugin names itself and needs no injected service', () => {
  assert.equal(M.name, 'mcp-lazy')
  assert.deepEqual(M.inject, [])
})

console.log('\nactivity: concurrent agents')
{
  const calls = []
  const controllers = new Map([
    ['demo', { noteRunning: () => calls.push('running'), noteIdle: () => calls.push('idle'), touch: () => calls.push('touch') }],
  ])
  const activity = M.createActivityTracker(controllers)
  activity.running({ id: 'parent' })
  check('the first running agent arms the controller once', () => {
    assert.deepEqual(calls.filter((c) => c === 'running'), ['running'])
  })
  calls.length = 0
  activity.running({ id: 'sub' })
  check('a second running agent never double-arms the counter', () => {
    assert.deepEqual(calls.filter((c) => c === 'running'), [])
  })
  calls.length = 0
  activity.idle({ id: 'sub' })
  check('a subagent going idle does NOT release while the parent runs', () => {
    assert.deepEqual(calls.filter((c) => c === 'idle'), [], 'the parent is still running')
    assert.equal(activity.size, 1)
  })
  activity.idle({ id: 'parent' })
  check('the last idle edge releases exactly once', () => {
    assert.deepEqual(calls.filter((c) => c === 'idle'), ['idle'])
    assert.equal(activity.size, 0)
  })
}
{
  const calls = []
  const controllers = new Map([
    ['demo', { noteRunning: () => calls.push('running'), noteIdle: () => calls.push('idle'), touch: () => {} }],
  ])
  const activity = M.createActivityTracker(controllers)
  activity.running({ id: 'a' })
  activity.drop({ id: 'a' })
  check('a disposed agent stops counting as running', () => {
    assert.equal(activity.size, 0)
    assert.deepEqual(calls, ['running', 'idle'])
  })
  check('an unknown idle edge is ignored, not counted twice', () => {
    activity.idle({ id: 'never-ran' })
    assert.deepEqual(calls, ['running', 'idle'])
  })
}

console.log(`\n${passed} checks passed\n`)
process.exit(process.exitCode ?? 0)
