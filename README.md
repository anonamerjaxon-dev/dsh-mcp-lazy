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

The saving is **idle RAM and stray processes** — measured ~35 MB across all four
servers, about **2.7%** of this DSH process's 1.27 GB footprint. It is **not** a
token saving: MCP tools are already per-preset, so a `standard` session never paid
for them.

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
            transport: stdio
            command: /Users/jackson/.local/bin/genoffice
            args: [mcp]
            toolCallTimeoutMs: 180000
            failOnStartupError: false
            maxInstructionBytes: 4096
```

**Then disable the preset's own row for that server.** Two owners of one
`serverName` start the server twice (the duplicate-row trap).

`dsh-health` checks the arrangement: that the eager row is disabled, and whether
the lazy-owned server is currently up or down.

## Tests

```
node test.mjs     # 22 offline checks, no server and no model call
```

The timing rules are testable because `createServerController` takes an injected
clock and owns no timers: grace period, "never while running", touch restarts the
timer, reopen after release, and a failed open leaving the server closed.

Two bugs these tests caught during development:

- a getter and a method both named `open` on one object literal **shadow each
  other**, so `ctrl.open` returned the async function and every "still closed?"
  assertion passed for the wrong reason — it is `isOpen` now;
- the failure path originally left `open` looking true after a rejected mount.

## Licence

MIT.
