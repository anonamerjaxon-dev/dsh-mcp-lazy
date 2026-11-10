/**
 * dsh-lazy-mcp — start an MCP server when a session first needs it, and release
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
 * idle RAM and stray processes, measured at ~250 MB for five idle servers on
 * 2026-10-31 (GenOffice alone ~157 MB). An earlier comment said ~35 MB; that was
 * wrong. This plugin is worth it for tidiness and for not launching a GUI app
 * (GenOffice) unasked — not for a large memory win. Saying otherwise would be
 * overselling it.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { argv, execPath } from 'node:process'

export const name = 'mcp-lazy'

/** Nothing beyond events: the MCP client brings its own `tools` inject. */
export const inject = []

/**
 * Every place the DSH installation's `package.json` could be, most specific
 * first. All of them are derived at runtime — **no absolute path belongs in
 * this file**.
 *
 * Why this exists: the plugin is loaded from the *profile*, whose node_modules
 * holds no `@deepseek-ai/*` packages, so `import('@deepseek-ai/dsh-mcp-client')`
 * there fails with ERR_MODULE_NOT_FOUND. The host's copy has to be found by
 * path. An earlier version hard-coded `/Users/<name>/.nvm/...`, which resolved
 * on exactly one machine and nowhere else — fine while the only install was a
 * `link:` to this checkout, fatal the moment anyone installs the package.
 */
export function hostPkgCandidates() {
  // 1. Explicit override, for tests and unusual layouts. When it is set it is
  //    the ONLY candidate: a wrong value must fail loudly rather than quietly
  //    resolve somewhere else, or the override lies about what it did.
  if (process.env.DSH_HOST_PKG) return [process.env.DSH_HOST_PKG]
  const out = []
  // 2. Inside DSH: argv[1] is the host's own bin, so Node walks up from it and
  //    lands in `<dsh>/node_modules/@deepseek-ai/...`.
  if (argv[1]) out.push(path.resolve(argv[1]))
  // 3. Beside the running node binary: `<node>/lib/node_modules/@deepseek-ai/dsh`.
  //    Covers a global install when the entry script is not the host bin
  //    (a test runner, an ACP host, a wrapper). A plain path join, not a
  //    resolve: a missing layout must yield a candidate that fails later, never
  //    a throw from inside the list builder.
  out.push(path.join(path.dirname(execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return out
}

/**
 * Resolve a host package by path, from the DSH installation rather than the
 * profile.
 *
 * @param specifier  Short name, e.g. `mcp-client` for `@deepseek-ai/dsh-mcp-client`.
 * @param hostPkg    Optional single candidate, honoured first (tests pin this).
 * @throws When no candidate resolves, naming every one that was tried — a
 *         silent fallback is what made the original bug invisible.
 */
export function resolveMcpClient(specifier = 'dsh-mcp-client', hostPkg) {
  const tried = []
  const candidates = hostPkg ? [hostPkg] : hostPkgCandidates()
  for (const candidate of candidates) {
    try {
      return createRequire(candidate).resolve(`@deepseek-ai/${specifier}`)
    } catch (error) {
      tried.push(`${candidate} (${error?.code ?? error?.message ?? 'error'})`)
    }
  }
  throw new Error(
    `mcp-lazy: cannot locate @deepseek-ai/${specifier} from any DSH installation.\n` +
    `  tried:\n${tried.map((t) => `    - ${t}`).join('\n')}\n` +
    '  fix: set DSH_HOST_PKG to the DSH install\'s package.json, or install DSH so ' +
    'that @deepseek-ai/* sits under <node>/lib/node_modules.',
  )
}

/**
 * The preset an agent is running, straight from the registry that owns the
 * answer. `undefined` when the registry is absent (a preset-free boot) or the
 * call throws — both mean "we cannot prove this session may use the server".
 *
 * @param ctx   Host context; only `agentPresets` is read.
 * @param agent The agent whose composition is being asked about.
 */
export function presetOf(ctx, agent) {
  try {
    const preset = ctx?.agentPresets?.composedPreset?.(agent?.ctx)
    return typeof preset === 'string' ? preset : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a server spec permits opening for a given preset.
 *
 * `allowPresets` omitted or empty means "any preset" — the pre-2026-11-04
 * behaviour, kept for a server that genuinely belongs everywhere. When the list
 * IS given, an unresolvable preset (`undefined`) is treated as NOT allowed: the
 * whole point is to avoid launching a heavy server for a session that cannot
 * use it, so the safe direction is to stay shut.
 *
 * @param spec   { allowPresets?: string[] }
 * @param preset Preset id, or undefined when unknown.
 */
export function specMayOpen(spec, preset) {
  const allow = spec?.allowPresets
  if (!Array.isArray(allow) || allow.length === 0) return true
  return typeof preset === 'string' && allow.includes(preset)
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

/**
 * Track which agents are running, keyed by agent id.
 *
 * The `agent/status` payload DOES carry `agent`: dsh-agent's `agentEvents()`
 * fuses `{ ...payload, agent }` into every agent-scoped emit (verified in
 * dsh-agent/lib/index.js, `agentEvents`). An earlier version assumed it did
 * not and tracked a single `'any'` marker, so with a parent turn and a subagent
 * running together, the subagent going idle cleared the marker and armed an
 * MCP release in the middle of the parent's turn.
 *
 * `noteRunning`/`noteIdle` are called only on the 0↔1 edges because the
 * controller keeps a counter, not a boolean.
 */
export function createActivityTracker(controllers) {
  const running = new Set()
  const each = (fn) => { for (const c of controllers.values()) fn(c) }
  const idOf = (agent) => (typeof agent?.id === 'string' && agent.id !== '' ? agent.id : 'any')
  return {
    get size() { return running.size },
    running(agent) {
      const wasEmpty = running.size === 0
      running.add(idOf(agent))
      if (wasEmpty) each((c) => c.noteRunning())
      each((c) => c.touch())
    },
    idle(agent) {
      if (!running.delete(idOf(agent))) return
      if (running.size === 0) each((c) => c.noteIdle())
    },
    drop(agent) {
      if (!running.delete(idOf(agent))) return
      if (running.size === 0) each((c) => c.noteIdle())
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
  const activity = createActivityTracker(controllers)

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

  // ── who may open a server ──────────────────────────────────────────────
  // Opening on EVERY session's first message defeats the point. Observed
  // 2026-11-04: a `standard` session — whose preset exposes 0 MCP servers and
  // no genoffice tool at all — started GenOffice, a ~150 MB GUI app, because the
  // trigger only asked "did a session start?", never "can this session use it?".
  // That is the same cost this plugin exists to remove, just moved from boot to
  // the first message.
  //
  // `ctx.agentPresets.composedPreset(agent.ctx)` is the registry's own answer to
  // "which preset is this agent running", the same call `dsh-preset-tool-gate`
  // makes before restricting tools.
  const openFor = async (agent, why) => {
    const preset = presetOf(ctx, agent)
    for (const spec of servers) {
      if (!specMayOpen(spec, preset)) continue
      const ctrl = controllerFor(spec.serverName)
      if (ctrl.isOpen) continue
      ctrl.noteSession()
      const result = await ctrl.open()
      if (!result.ok) log('warn', `could not open ${spec.serverName} on ${why}: ${result.reason}`)
    }
  }

  // ── trigger: the session's first message ───────────────────────────────
  // `agent/created` is serial and awaited and fires before the loop releases
  // queued input, so the server is up before that first request is assembled.
  // The preset is already bound by then: the session controller mounts it in the
  // Agent's setup callback, which runs before announce() emits this event.
  ctx.on('agent/created', async ({ agent }) => {
    if (typeof agent?.id !== 'string') return
    await openFor(agent, 'first message')
  })

  // A blank session may change preset before its first turn — `standard` to
  // `office` is the ordinary way in. Without this, that session would reach the
  // turn with the server still shut, because the gate correctly said "no" to
  // `standard` a moment earlier. Opening here costs nothing for the presets that
  // do not match: `openFor` re-reads the CURRENT preset each time.
  ctx.on('agent-preset/selected', async (sessionId) => {
    const agent = ctx.agents?.get?.(sessionId)
    if (agent === undefined) return
    await openFor(agent, 'preset selected')
  })

  ctx.on('agent/disposed', ({ agent }) => {
    activity.drop(agent)
    for (const ctrl of controllers.values()) ctrl.dropSession()
  })

  // ── activity: a turn starting or ending, and any tool call ─────────────
  // Keyed by agent id, so one subagent finishing cannot make a still-running
  // parent look idle. A `running` transition touches activity; only the LAST
  // idle transition re-arms the release clock.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') activity.running(agent)
    else activity.idle(agent)
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
