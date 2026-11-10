---
name: lazy-mcp-loading
description: Stops an agent from starting MCP servers it never uses at boot, and releases the ones it does use once they are genuinely idle. Use when MCP servers launch at startup and sit idle, when a session's context is bloated by dozens of unused MCP tool schemas, when a heavy server (a GUI app, a database, a browser) is spawned for a session that cannot use it, or when the user asks why an MCP server is always running.
---

# Lazy MCP loading

MCP servers are usually mounted **eagerly**: every server declared in an agent's
config is spawned when the agent starts, and keeps its tool schemas in the
request for the whole session. That is fine for one server and wasteful for ten.
This skill decides which servers should stay resident, which should start on
first use, and how to prove the change worked.

## Diagnose before changing anything

Measure, don't assume. If `npx dsh-lazy-mcp audit` is available, run it first:
it lists every MCP server your agents declare, which are running, and the memory
each one's whole process subtree holds. Otherwise get the same three numbers by
hand:

1. **Boot cost.** Start the agent, use nothing, and list child processes. Every
   server already alive is eager. Note its RSS.
2. **Schema cost.** Count the tool names the server contributes. Each one is a
   schema in every request; 20 tools is roughly 2–5k tokens before any work
   happens.
3. **Actual use.** Look at the last week of sessions. A server used in 0 of 30
   sessions is the case worth fixing; a server used in 28 of 30 is not.

If a server is used in most sessions, **leave it resident**. Lazy loading it
costs a cache break on every open and buys nothing.

## The decision table

| Observation | Action |
|---|---|
| Never used, heavy (GUI app, browser, DB, model server) | Lazy-load, gate to the presets that actually expose it |
| Never used, light (<50 MB) | Lazy-load if the schema count is large; otherwise leave it |
| Used in most sessions | Keep resident |
| Used in some sessions, cheap to start | Lazy-load with a short idle window |
| Server that must hold state across turns (indexing, a session-scoped browser) | Keep resident, or lazy-load with a very long idle window |
| Used only by one preset | Keep resident *in that preset*, not globally |

The last row matters most. A server that only one preset needs should not be
declared globally and gated later — declare it where it belongs.

## Gate by capability, not by "a session started"

This is the failure that makes lazy loading look broken. A trigger that fires on
"any session's first message" will start a heavy server for a session whose
preset never exposes its tools. That is the same waste as eager boot, just moved
later — and it is worse, because nobody expects it.

Before opening a server, ask the host which composition the session is actually
running, and open only if that composition includes this server. Read the
preset from the host's own registry; never infer it from the model name, the
working directory, or a config file.

## Releasing safely

A server must never disappear mid-call. Four rules, in order:

1. **Idle means no activity at all**, tracked as a timestamp refreshed by any
   tool call, any agent status change, and any session creation.
2. **Never release while any agent is running.** Track agents by id, not with a
   single boolean: with a parent turn and a subagent running together, the
   subagent finishing must not mark the whole host idle.
3. **Never release on the first idle moment.** Use a real grace period
   (10 minutes is a sane default) that restarts after every use.
4. **Release only between turns**, from a slow timer that refuses to act while
   anything is running.

Re-opening must be automatic and awaited. If something asks for the server after
release, open it again before the request is assembled; never leave a
registered-but-dead tool in the tool list.

## Know what you are not saving

Be precise with the numbers, because the wrong claim makes the whole change look
illegitimate:

- You save **idle RAM and stray processes**. Measure it; do not estimate it.
- You do **not** save context. Opening the server mid-session changes the tool
  array and costs one cache break — often around 10k tokens. That is a real cost
  paid once per open.
- You may make **latency worse** on the first use of the session, by the server's
  startup time.

If a server is heavy but used early in most sessions, lazy loading trades a
predictable boot cost for a less predictable first-turn cost. Say so.

## Recipes

**DeepSeek Harness.** Disable the preset's `dsh-mcp-client` row so nothing mounts
at boot, then let a lazy gateway own the same server config and mount it on
first use. The reference implementation is `dsh-lazy-mcp`
(`github.com/anonamerjaxon-dev/dsh-mcp-lazy`, MIT, `npm i dsh-lazy-mcp`): it takes the server spec,
gates on `allowPresets`, and releases after `idleMs` with no agent running.

```yaml
- insert:
    - id: mcp-lazy
      name: 'dsh-lazy-mcp'
      config:
        idleMs: 600000      # 10 minutes of true inactivity
        sweepMs: 60000
        servers:
          - serverName: genoffice
            allowPresets: [office]
            transport: stdio
            command: genoffice      # resolved on PATH, never an absolute path
            args: [mcp]
            failOnStartupError: false
```

**Claude Code, Cursor, Copilot, Codex CLI.** These mount what their MCP config
declares at session start and have no built-in idle release. The equivalent is
to keep the heavy server *out* of the always-on config and enable it per project
or per session:

- keep one small always-on server for discovery;
- put heavy servers in a project-scoped config that is added when the work
  starts and removed after;
- prefer one gateway server that proxies several backends over N servers each
  exposing their own schemas;
- never add a GUI application as a startup server.

## Verification checklist

Do not call the change done until all five hold:

1. Boot with the agent, touch nothing — the heavy server is not in the process list.
2. Start a turn in a preset that *does* expose it — the server opens, and its
   tools appear in the request.
3. Start a turn in a preset that does *not* — the server stays shut.
4. Run a long turn past the idle window — the server stays up.
5. Leave it idle past the window — the server is released, and the next use
   re-opens it without a manual restart.

If step 4 fails, the activity tracking is keyed wrongly (see "Track agents by
id"). If step 3 fails, the gate is checking "did a session start" instead of
"can this session use it".

## Common mistakes

- **Two mounts of one server.** Disabling the original row but leaving it
  configured, then adding a second row with the same `serverName`, starts the
  server twice.
- **Absolute paths in shipped config.** A config with `/Users/<name>/...` in it
  works on exactly one machine. Use a PATH-resolved command.
- **A version pin instead of a range.** Pinning a plugin to one exact host
  version makes it get skipped, silently, on the next host upgrade.
- **Claiming a context saving.** Opening costs a cache break; only idle memory
  is saved.
