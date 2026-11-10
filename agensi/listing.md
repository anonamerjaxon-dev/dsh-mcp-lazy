# Agensi listing — copy-paste pack

Everything the submit form asks for, written out. Paste it as-is; the fields map
one-to-one to `/dashboard/submit`.

---

## Title (max ~60 characters)

```
Lazy MCP Loading: stop idle MCP servers
```

## Short description (one line, used on the card)

```
Decides which MCP servers should start at boot and which should wait for first use — then proves the change with measurements instead of guesses.
```

## Category

`LLM Ops`

## Tags

```
mcp, context-window, memory, agents, llm-ops, claude-code, cursor, deepseek-harness, performance
```

## Price

`$9.00` one-time — recommended first listing price.

Reasoning: the marketplace average is about $11 and this is a single skill, not a
bundle. At $9 the 30-day money-back guarantee is cheap enough that a refund
costs you nothing and a bad review is unlikely. Do **not** launch at $29+; the
refund rate on a one-page instruction skill at that price is what kills a
creator's ranking.

## Full description

```markdown
# Your agent starts MCP servers it never uses

Every server declared in an agent's config is spawned at boot, and its tool
schemas sit in every request for the rest of the session. With one server that
is invisible. With ten it is the difference between a fast session and a slow
one — and a GUI application running in the background that no session ever
called.

This skill makes that decision explicit instead of accidental.

## What it does

- A three-number diagnosis you run before changing anything: boot processes,
  tool-schema count, and real use over the last week of sessions.
- A decision table for which servers stay resident and which start on first use.
  Most guidance says "lazy-load everything", which is wrong for the server you
  use in 28 of 30 sessions.
- The four release rules that keep a server from vanishing mid-call, including
  the agent-keying bug that lets a finishing subagent mark a still-running
  parent idle.
- A capability gate: open a server only when the session's own composition
  includes it. Checking "did a session start" is the mistake that makes lazy
  loading look broken — it launches the heavy server for a session that cannot
  use it.
- Honest numbers about what you save. You save idle RAM and stray processes.
  You do not save context: opening mid-session is one cache break, often around
  10k tokens.
- Copy-paste config for DeepSeek Harness, plus the pattern for Claude Code,
  Cursor, Copilot and Codex CLI, which have no built-in idle release.
- A five-step verification checklist, so you can prove the change rather than
  hope.

## Who it is for

Anyone running two or more MCP servers: coding agents, office or design
presets, browser automation, database servers, local model servers. It is
especially for people who noticed a heavy application spawning at startup and
could not work out why.

## Example

A `standard` session — one that exposes no MCP tools at all — was starting a
~150 MB GUI application at boot because a different preset declared it. Gating
the open on the session's actual preset moved it to first use, and the idle
release removed it afterwards. The skill walks through that exact diagnosis.

## Companion tool

The DeepSeek Harness reference implementation is free and MIT licensed:
`npx dsh-lazy-mcp audit` works out of the box, source at github.com/anonamerjaxon-dev/dsh-mcp-lazy. The skill is the judgment — which
servers, which gate, which idle window, and how to verify it. You can use the
skill without the tool, and the tool without the skill.

## Guarantee

30-day money-back, as on every Agensi listing. If it does not change how you
configure your agents, ask for the refund.
```

## Compatible agents (check all that apply)

```
Claude Code, Cursor, GitHub Copilot, Codex CLI, Gemini CLI, Windsurf, Cline,
Aider, VS Code, Zed, Kiro, OpenClaw
```

## Requirements

```
An agent that supports MCP, and at least one MCP server configured.
No API keys. No network access. No scripts — the skill is instructions only.
```

## What is included

```
SKILL.md — the diagnosis procedure, decision table, release rules, config
recipes and verification checklist.
```

## Support

```
Issues and questions: github.com/anonamerjaxon-dev/dsh-mcp-lazy/issues
```

## Before you submit — their 8-point scan

The scan reads every line of the skill. This one is deliberately clean:

| Check | Status |
|---|---|
| File structure | one `SKILL.md`, folder name matches `name:` |
| File types | text only, no binaries, no scripts |
| Dangerous command patterns | none — config examples only, no shell execution |
| Secrets | none |
| Environment variable harvesting | none |
| Network access | none |
| Obfuscation | none |
| Prompt injection | none — instructions address the operator, not the buyer's data |

## After it goes live

1. Copy the listing URL into `README.md` of the plugin repo as "also available
   as a skill".
2. Set your affiliate link on the same listing: as a creator who is also an
   affiliate, a referred buyer pays you 70% + 20% = 90%.
3. Expect volume of **zero to a few**. The whole marketplace is under $1k MRR
   with ~5,900 listings, so this is a portfolio piece and a publishing habit,
   not income. Price it so a refund never hurts.
