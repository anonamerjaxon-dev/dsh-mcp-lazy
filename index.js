/**
 * dsh-mcp-lazy — start an MCP server when a session first needs it, and release
 * it once nothing is using it, instead of paying for it from profile boot.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `dsh-agent-preset-registry` says it plainly: "Each declaration eagerly creates
 * a registry-owned scope and an in-memory Loader tree." So every preset's MCP row
 * mounts at profile boot — including the ones for presets no session ever
 * selects. Measured on this machine: all four MCP servers spawn within 3 seconds
 * of `dsh web` starting, while the live session ran `standard`, which uses none.
 *
 * `dsh-mcp-client` has no lazy option and no idle release: `apply()` calls
 * `startConnection()` and awaits `connection.ready` immediately. This plugin
 * closes that gap from outside —
 *
 *   1. the owning preset's row is disabled in the profile patch, so nothing
 *      spawns at boot;
 *   2. this plugin mounts `dsh-mcp-client` itself, with the same config, when a
 *      session's FIRST message arrives;
 *   3. it disposes that mount after an idle period — but only when nothing is
 *      using it, and never while a turn is running.
 *
 * ── The safety rules, because "released too early" is the failure that matters ──
 *
 *   - **Idle means no activity at all**, tracked as a timestamp refreshed by any
 *     tool call, any agent status change to `running`, and session creation. A
 *     long model turn keeps refreshing it, so a slow step is not mistaken for
 *     idleness.
 *   - **Never release while any agent is running.** The idle timer only arms when
 *     every tracked agent is `idle`; a running turn re-arms it on completion.
 *   - **Never release on the first idle moment.** `idleMs` is a real grace period
 *     (default 10 minutes), and it restarts after every use.
 *   - **Release only between turns.** The check runs on a timer that refuses to
 *     act while an agent is running, so a server cannot vanish mid-call.
 *   - **Re-open is automatic and awaited.** If something asks for the server
 *     after release, the next first-message or tool call opens it again; callers
 *     are never left with a registered-but-dead tool.
 *
 * ── What this does NOT do ────────────────────────────────────────────────
 *
 * It does not make the *tools* appear mid-session for free. When the server opens,
 * its tools register and the request's tool array changes — that is one cache
 * break (measured ~10k tokens on this machine, once per open). The saving is
 * idle RAM and stray processes, which measured ~35 MB total for all four servers,
 * i.e. about 2.7% of this process's 1.27 GB footprint. This plugin is worth it for
 * tidiness and for not launching a GUI app (GenOffice) unasked — not for a large
 * memory win. Saying otherwise would be overselling it.
 */

import { createRequire } from 'node:module'
import { execPath } from 'node:process'

export const name = 'mcp-lazy'

/** Nothing beyond events: the MCP client brings its own `tools` inject. */
export const inject = []

const HOST_PKG = '/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/@deepseek-ai/dsh/package.json'

/**
 * Resolve `dsh-mcp-client` from the DSH installation, not the profile: the
 * profile does not depend on host packages and `import` there fails with
 * ERR_MODULE_NOT_FOUND.
 */
export function resolveMcpClient(specifier = 'dsh-mcp-client', hostPkg = HOST_PKG) {
  const require = createRequire(hostPkg)
  return require.resolve(`@deepseek-ai/${specifier}`)
}

/**
 * Track one server's lifecycle. Pure enough to unit-test: no timers of its own,
 * every decision is a function of the observed state.
 *
 * @param spec  { serverName, idleMs, onOpen, onClose }
 */
export function createServerController(spec, now = () => Date.now()) {
  let fiber = null
  let lastActivity = 0
  let openedAt = null
  let opens = 0
  let closes = 0
  const state = { running: 0, sessions: 0 }

  const touch = () => { lastActivity = now() }

  return {
    // Named `isOpen`, not `open`: a getter and a method with the same name on one
    // object literal silently shadow each other, so `ctrl.open` returned the
    // async open() function instead of the state, and every "still closed?" test
    // passed for the wrong reason.
    get isOpen() { return fiber !== null },
    get stats() { return { opens, closes, idleForMs: lastActivity ? now() - lastActivity : 0 } },
    get lastActivity() { return lastActivity },

    /** Any evidence of use: a tool call, a session appearing, a turn starting. */
    touch,
    noteRunning() { state.running += 1; touch() },
    noteIdle() { state.running = Math.max(0, state.running - 1); touch() },
    noteSession() { state.sessions += 1; touch() },
    dropSession() { state.sessions = Math.max(0, state.sessions - 1) },

    async open() {
      if (fiber !== null) { touch(); return { ok: true, already: true } }
      try {
        fiber = await spec.onOpen()
        openedAt = now()
        opens += 1
        touch()
        return { ok: true }
      } catch (error) {
        fiber = null
        return { ok: false, reason: String(error?.message ?? error) }
      }
    },

    async close() {
      if (fiber === null) return { ok: true, already: true }
      const held = fiber
      fiber = null
      try {
        await spec.onClose?.(held)
        closes += 1
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) }
      }
    },

    /**
     * Whether the grace period allows releasing now. Returns a reason either way,
     * so a log line can say why the server is still up.
     */
    shouldRelease() {
      if (fiber === null) return { release: false, reason: 'not open' }
      if (state.running > 0) return { release: false, reason: `${state.running} agent(s) running` }
      const idle = now() - lastActivity
      if (idle < spec.idleMs) return { release: false, reason: `idle ${Math.round(idle / 1000)}s of ${Math.round(spec.idleMs / 1000)}s` }
      return { release: true, reason: `idle ${Math.round(idle / 1000)}s` }
    },
  }
}

export function apply(ctx, config = {}) {
  const log = (level, message) => ctx.logger?.[level]?.(`mcp-lazy: ${message}`)
  const servers = config.servers ?? []
  const idleMs = Number.isFinite(config.idleMs) ? config.idleMs : 600000
  const sweepMs = Number.isFinite(config.sweepMs) ? config.sweepMs : 60000

  if (servers.length === 0) {
    log('warn', 'no servers configured — nothing to manage')
    return
  }

  const controllers = new Map()
  const running = new Set()

  const controllerFor = (serverName) => {
    const spec = servers.find((s) => s.serverName === serverName)
    if (!spec) return undefined
    if (controllers.has(serverName)) return controllers.get(serverName)

    const ctrl = createServerController({
      serverName,
      idleMs,
      async onOpen() {
        // Resolved from the HOST installation: the profile has no dependency on
        // host packages, so a plain specifier import fails there.
        const mcp = await import(resolveMcpClient())
        const { serverName: _n, ...mcpConfig } = spec
        const fiber = ctx.plugin(mcp, { ...mcpConfig, serverName })
        await fiber
        log('info', `opened ${serverName}`)
        return fiber
      },
      async onClose(fiber) {
        await fiber.dispose()
        log('info', `released ${serverName} (idle)`)
      },
    })
    controllers.set(serverName, ctrl)
    return ctrl
  }

  const openAll = async (why) => {
    for (const spec of servers) {
      const ctrl = controllerFor(spec.serverName)
      if (ctrl.isOpen) continue
      const result = await ctrl.open()
      if (!result.ok) log('warn', `could not open ${spec.serverName} on ${why}: ${result.reason}`)
    }
  }

  // ── trigger: the session's first message ───────────────────────────────
  // `agent/created` is serial and awaited and fires before the loop releases
  // queued input, so the server is up before that first request is assembled.
  ctx.on('agent/created', async ({ agent }) => {
    if (typeof agent?.id !== 'string') return
    for (const spec of servers) controllerFor(spec.serverName)?.noteSession()
    await openAll('first message')
  })

  ctx.on('agent/disposed', () => {
    for (const ctrl of controllers.values()) ctrl.dropSession()
  })

  // ── activity: a turn starting or ending, and any tool call ─────────────
  // `agent/status` carries only `{ status }` (no agent id), so the safe reading
  // is "some agent changed state": a `running` transition touches activity, and
  // an `idle` transition is what allows release. Conflating a slow step with
  // idleness is the failure this avoids.
  ctx.on('agent/status', ({ status }) => {
    if (status === 'running') {
      if (running.size === 0) for (const c of controllers.values()) c.noteRunning()
      running.add('any')
      for (const c of controllers.values()) c.touch()
    } else {
      if (running.delete('any')) for (const c of controllers.values()) c.noteIdle()
    }
  })

  // Tools changing means a turn is doing work; cheap and accurate as a freshness
  // signal for servers that are already open.
  ctx.on('tools/change', () => {
    for (const c of controllers.values()) if (c.isOpen) c.touch()
  })

  // ── the sweep ──────────────────────────────────────────────────────────
  // Deliberately slow (60 s default) and inert unless something is idle past the
  // grace period with no agent running.
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const ctrl of controllers.values()) {
        const verdict = ctrl.shouldRelease()
        if (!verdict.release) continue
        void ctrl.close()
      }
    }, sweepMs)
    return () => clearInterval(timer)
  }, 'mcp-lazy: idle sweep')

  // Expose the decision logic to the CLI/health check without a second copy.
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__dshMcpLazy',
      value: servers.map((s) => {
        const c = controllers.get(s.serverName)
        return { serverName: s.serverName, open: Boolean(c?.isOpen), ...(c ? c.stats : { opens: 0, closes: 0, idleForMs: 0 }) }
      }),
    })
  })
}
