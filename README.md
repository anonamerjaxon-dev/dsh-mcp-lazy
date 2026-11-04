# dsh-mcp-lazy

Start an MCP server when a session first needs it, and release it after a real
idle period — instead of mounting every preset's servers at profile boot.

## The problem

`dsh-agent-preset-registry` is explicit: *"Each declaration eagerly creates a
registry-owned scope and an in-memory Loader tree."* And `dsh-mcp-client.apply()`
calls `startConnection()` and awaits `connection.ready` immediately. Together
that means **every preset's MCP servers spawn at boot**, whether or not any
session selects that preset.

Measured on this machine: all four servers started within **3 seconds** of
`dsh web`, while the live session ran `standard` — which uses none of them.
GenOffice in particular is a full GUI application that was being launched
unasked, for the `office` preset, which **no recorded session had ever used**.

## What it does

1. The owning preset's `mcp-<name>` row is **disabled**, so nothing spawns at boot.
2. This plugin mounts `dsh-mcp-client` itself, with the same config, when a
   session's **first message** arrives (`agent/created` — serial and awaited, so
   the server is up before that first request is assembled).
3. It disposes the mount after an idle grace period — `idleMs`, default 10 min.

## The release rules (this is the part that matters)

Releasing too early is the failure that hurts, so:

- **Idle means no activity at all.** Any tool change, any turn start, any session
  creation refreshes the clock. A slow model step is not mistaken for idleness.
- **Never while anything is running.** An `agent/status: running` blocks release
  regardless of elapsed time; the grace period restarts when it goes idle.
- **A real grace period.** 10 minutes by default, restarted by every use.
- **Re-open is automatic.** The next first message opens it again; a failed open
  is reported and leaves the server closed (never registers dead tools).

## Cost, stated honestly

The saving is **idle RAM and stray processes** — re-measured 2026-10-31 with
five idle servers: **~250 MB RSS total** (GenOffice ~157 MB, playwright ~39 MB,
the REA shim ~30 MB, blender ~20 MB, figcraft ~2 MB). The earlier "~35 MB" figure
was wrong. It is **not** a token saving: MCP tools are already per-preset, so a
`standard` session never paid for them.

There is one real token cost: when the server opens mid-session its tools register
and the request's tool array changes — one cache break, measured ~10k tokens,
once per open.

So this is worth it for **tidiness and for not launching a GUI app unasked**, not
for a big memory win. Saying otherwise would oversell it.

## Config

```yaml
- insert:
    - id: mcp-lazy
      name: 'dsh-mcp-lazy'
      config:
        idleMs: 600000      # grace period before release
        sweepMs: 60000      # how often the idle check runs
        servers:
          - serverName: genoffice
            allowPresets: [office]   # only these presets may trigger it
            transport: stdio
            command: /Users/jackson/.local/bin/genoffice
            args: [mcp]
            toolCallTimeoutMs: 180000
            failOnStartupError: false
            maxInstructionBytes: 4096
```

### `allowPresets` — which sessions may open a server

Omitted means **every preset may open it** (the original behaviour). A list
restricts opening to those presets, read from the registry with
`ctx.agentPresets.composedPreset(agent.ctx)` — the same call
`dsh-preset-tool-gate` makes.

Set it whenever a server belongs to specific presets. Without it the trigger
fires on *any* session's first message, which is the waste this plugin exists to
remove, merely postponed. Measured 2026-11-04: a `standard` session — whose
preset compiles in zero MCP servers and no `mcp__genoffice__*` tool — launched
GenOffice (a ~150 MB GUI application) and kept it running.

Two details worth knowing:

- An **unresolvable** preset (no registry, or a throwing lookup) counts as *not
  allowed* when a list is given. Staying shut is the safe direction.
- A blank session can change preset **after** creation, so switching `standard`
  → `office` re-evaluates and opens on the `agent-preset/selected` event.

**Then disable the preset's own row for that server.** Two owners of one
`serverName` start the server twice (the duplicate-row trap).

`dsh-health` checks the arrangement: that the eager row is disabled, and whether
the lazy-owned server is currently up or down.

## Tests

```
node test.mjs     # 38 offline checks, no server and no model call
```

The timing rules are testable because `createServerController` takes an injected
clock and owns no timers: grace period, "never while running", touch restarts the
timer, reopen after release, and a failed open leaving the server closed. The
preset gate is tested the same way — `presetOf` and `specMayOpen` are pure, so the
"a `standard` session must not open an `office` server" rule is a unit test rather
than a live experiment.

Two bugs these tests caught during development:

- a getter and a method both named `open` on one object literal **shadow each
  other**, so `ctrl.open` returned the async function and every "still closed?"
  assertion passed for the wrong reason — it is `isOpen` now;
- the failure path originally left `open` looking true after a rejected mount.

## Licence

MIT.
