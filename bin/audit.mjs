#!/usr/bin/env node
/**
 * `dsh-lazy-mcp audit` — the portable half of this package.
 *
 * The plugin only runs inside DeepSeek Harness. This does not: it reads the MCP
 * config of whatever agent you use, matches it against the running process
 * table, and tells you which servers are costing you memory for no reason.
 *
 * Read-only by construction: it opens config files, runs `ps`, and prints. It
 * writes nothing, installs nothing and makes no network calls.
 *
 *   npx dsh-lazy-mcp audit
 *   npx dsh-lazy-mcp audit --json
 *   npx dsh-lazy-mcp audit --cwd /path/to/project
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serversFromConfig, parseDshPatchServers, summarize } from '../lib/lazy-audit.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const cwdIndex = args.indexOf('--cwd')
const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? path.resolve(args[cwdIndex + 1]) : process.cwd()

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}
const readText = async (file) => {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}
const home = os.homedir()

// ── config discovery ───────────────────────────────────────────────────────
// Ordered by how likely they are to exist on a machine that uses several
// agents. A missing file is normal, not an error.
const JSON_CONFIGS = [
  ['Claude Code', path.join(home, '.claude.json')],
  ['Claude Code', path.join(cwd, '.mcp.json')],
  ['Cursor', path.join(home, '.cursor', 'mcp.json')],
  ['Cursor', path.join(cwd, '.cursor', 'mcp.json')],
  ['VS Code', path.join(cwd, '.vscode', 'mcp.json')],
  ['VS Code', path.join(home, 'Library/Application Support/Code/User/mcp.json')],
]

const servers = []
const sources = []
for (const [agent, file] of JSON_CONFIGS) {
  const config = await readJson(file)
  if (config === null) continue
  const found = serversFromConfig(config, agent, file)
  sources.push({ agent, file, count: found.length })
  servers.push(...found)
}

// DSH keeps its MCP servers in profile patches, not JSON.
const dshProfiles = path.join(home, '.dsh', 'profiles')
const gated = []
try {
  for (const profile of await readdir(dshProfiles, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    const file = path.join(dshProfiles, profile.name, 'cordis.patch.yml')
    const text = await readText(file)
    if (text === null) continue
    const parsed = parseDshPatchServers(text).filter((server) => server.command)
    // One serverName can appear twice: a disabled row handing over to a lazy
    // row. Keep the active one, and remember the gated one as a good sign.
    const active = parsed.filter((server) => !server.disabled)
    for (const server of parsed.filter((entry) => entry.disabled)) gated.push({ ...server, profile: profile.name })
    const seen = new Set()
    const found = active
      .filter((server) => (seen.has(server.serverName) ? false : seen.add(server.serverName)))
      .map((server) => ({ agent: `DSH (${profile.name})`, source: file, serverName: server.serverName, command: server.command, scope: 'profile' }))
    if (found.length === 0) continue
    sources.push({ agent: `DSH (${profile.name})`, file, count: found.length })
    servers.push(...found)
  }
} catch {
  // No DSH profiles: fine, this is the portable path.
}

// ── process table ──────────────────────────────────────────────────────────
// `ps` rather than a native binding: zero dependencies, works on macOS and
// Linux, and this is a diagnostic, not a supervisor.
let processes = []
try {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
  processes = table
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) return null
      return { pid: Number(match[1]), ppid: Number(match[2]), rssMb: Number(match[3]) / 1024, command: match[4] }
    })
    .filter((entry) => entry !== null && entry.rssMb >= 1)
} catch {
  processes = []
}

// ── report ─────────────────────────────────────────────────────────────────
const report = summarize(servers, processes)

if (json) {
  console.log(JSON.stringify({ cwd, sources, ...report }, null, 2))
  process.exit(0)
}

const relative = (file) => file.startsWith(home) ? `~${file.slice(home.length)}` : path.relative(cwd, file) || file

console.log('\nMCP servers on this machine\n')

if (sources.length === 0) {
  console.log('  No MCP config found for Claude Code, Cursor, VS Code or DSH.')
  console.log(`  Looked in ${JSON_CONFIGS.length} JSON paths and ${dshProfiles}/*/cordis.patch.yml\n`)
  process.exit(0)
}

for (const source of sources) {
  console.log(`  ${source.agent.padEnd(16)} ${relative(source.file)}   ${source.count} server(s)`)
}

console.log(`\n  ${report.totals.declared} declared, ${report.totals.running} running, ~${report.totals.rssMb} MB resident\n`)

if (gated.length > 0) {
  const names = [...new Set(gated.map((entry) => `${entry.serverName} (${entry.profile})`))]
  console.log(`  already gated by a disabled row: ${names.join(', ')}`)
  console.log('  that is the handover this plugin performs — nothing to do for those\n')
}

const width = Math.max(...report.rows.map((row) => row.serverName.length), 10)
for (const row of report.rows) {
  const state = row.running
    ? `${Math.round(row.rssMb)} MB${row.processCount > 1 ? ` (${row.processCount} proc)` : ''}`
    : 'idle'
  console.log(`  ${row.serverName.padEnd(width)}  ${row.verdict.padEnd(10)} ${state}`)
  console.log(`  ${' '.repeat(width)}  ${row.detail}`)
  console.log(`  ${' '.repeat(width)}  ${row.agent} · ${relative(row.source)}`)
  console.log()
}

const candidates = report.rows.filter((row) => row.verdict === 'lazy-load')
if (candidates.length === 0) {
  console.log('  Nothing to do: no declared server is both running and expensive.\n')
} else {
  console.log(`  Rewrite these ${candidates.length} to start on first use:`)
  for (const row of candidates) console.log(`    - ${row.serverName} (~${Math.round(row.rssMb)} MB idle)`)
  console.log('\n  The decision table that says whether they *should* be lazy-loaded:')
  console.log('  https://github.com/anonamerjaxon-dev/dsh-mcp-lazy#readme\n')
}
