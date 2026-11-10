/**
 * Pure logic for the portable `audit` command. No I/O, so every rule below is
 * testable without a browser, a process table or a config file on disk.
 *
 * The point of this module: `dsh-lazy-mcp` is a DSH plugin, but the *diagnosis*
 * it encodes — which MCP servers are running, how big they are, and whether a
 * session is likely to need them — is not DSH-specific. Claude Code, Cursor, VS
 * Code and DSH all declare MCP servers in a config file and all start them the
 * same eager way. That shared part is here.
 */

/** Commands that are almost never worth starting speculatively. */
const HEAVY_PATTERNS = [
  /genoffice/i,
  /playwright/i,
  /chromium/i,
  /electron/i,
  /blender/i,
  /figcraft/i,
  /photoshop/i,
  /unity/i,
  /docker/i,
  /postgres|mysqld|mongod/i,
  /ollama|llama|vllm/i,
]

/** Resident-set and process-table noise that is not a per-server cost. */
const MIN_RSS_MB = 1

/** Under this many MB, a rewrite buys nothing — even for a heavy-sounding name. */
const CHEAP_ENOUGH_MB = 25

/**
 * A rough weight class from the command alone.
 *
 * Deliberately a guess, and labelled as one in the output: the audit measures
 * real RSS for anything actually running, so this only decides what to say
 * about servers that are *not* running.
 *
 * @param command The server command line, e.g. "npx -y genoffice mcp".
 * @returns "heavy" | "light"
 */
export function guessWeight(command) {
  const text = String(command ?? '')
  return HEAVY_PATTERNS.some((pattern) => pattern.test(text)) ? 'heavy' : 'light'
}

/**
 * What to recommend for one server, given what was actually observed.
 *
 * The rules are ordered so that measurement beats guessing: an observed RSS
 * always outranks the name-based guess.
 *
 * @param {{weight: string, running: boolean, rssMb?: number}} observation
 */
export function verdict({ weight, running, rssMb = 0 }) {
  if (!running) {
    return {
      verdict: 'idle',
      detail: 'not running — costs nothing right now, so nothing to fix',
    }
  }
  const size = rssMb >= MIN_RSS_MB ? `~${Math.round(rssMb)} MB` : 'under 1 MB'
  // Below this, no rewriting is worth it whatever the name suggests: a 2 MB
  // launcher is not the problem, even when the launcher is "blender".
  if (rssMb < CHEAP_ENOUGH_MB) {
    return { verdict: 'keep', detail: `running at ${size}; not worth rewriting at this size` }
  }
  if (weight === 'heavy') {
    return { verdict: 'lazy-load', detail: `running at ${size}; heavy enough that starting it speculatively is the expensive case` }
  }
  if (rssMb >= 150) {
    return { verdict: 'lazy-load', detail: `running at ${size}; measured cost is high whatever the name suggests` }
  }
  return { verdict: 'keep', detail: `running at ${size}; cheap enough to stay resident` }
}

/**
 * Pull `serverName`/`command` pairs out of a DSH profile patch.
 *
 * Line-based on purpose: this package has no YAML dependency, and the shape it
 * needs (`serverName: x` followed by `command: y`) is fixed by the MCP config
 * schema. It will miss exotic formatting — it must never invent a server.
 *
 * Both shapes are real and both are handled:
 *   - `- serverName: genoffice`   a list item, as the bundle patch writes it
 *   - `  serverName: genoffice`   a mapping key, as an edited profile writes it
 * The second one is why the first version of this parser found nothing on a
 * machine that was running two servers.
 *
 * `disabled: true` is reported, not filtered: a row that is declared but off is
 * being managed by something else, and telling someone to "lazy-load" it would
 * be advice they already took.
 *
 * @param text Contents of a cordis.patch.yml.
 * @returns {{serverName: string, command?: string, transport?: string, disabled: boolean}[]}
 */
export function parseDshPatchServers(text) {
  const lines = String(text).split('\n')
  const rowStart = (index) => {
    for (let cursor = index; cursor >= 0; cursor -= 1) if (/^\s*-\s+(id|name):/.test(lines[cursor])) return cursor
    return 0
  }
  const rowEnd = (index) => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) if (/^\s*-\s+(id|name):/.test(lines[cursor])) return cursor
    return lines.length
  }
  const out = []
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s+)?serverName:\s*([A-Za-z0-9._-]+)/)
    if (!match) return
    // Bound the spec to the enclosing row. A fixed-size window leaks into the
    // next row and hands one server another's command — which made three
    // different servers report the same 921 MB process.
    const spec = lines.slice(index, rowEnd(index)).join('\n')
    const command = (spec.match(/^\s*command:\s*(.+)$/m)?.[1] ?? spec.match(/^\s*url:\s*(\S+)/m)?.[1])
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    const transport = spec.match(/^\s*transport:\s*(\S+)/m)?.[1]
    // `disabled` belongs to the enclosing row, which may put it before the
    // serverName — an edited profile writes id, name, disabled, then config.
    const row = lines.slice(rowStart(index), rowEnd(index)).join('\n')
    const disabled = /^\s*disabled:\s*true\s*$/m.test(row)
    out.push({ serverName: match[1], command, transport, disabled })
  })
  return out
}

/**
 * Read MCP servers out of a JSON config, whichever shape it uses.
 *
 * Handles the four that actually exist in the wild:
 *   - `{ mcpServers: { name: { command, args } } }`   Claude Code, Cursor
 *   - `{ servers:    { name: { command, args } } }`   VS Code
 *   - `{ projects: { "/path": { mcpServers: {...} } } }` Claude Code's nested form
 *
 * @param json Parsed config, or null.
 * @param agent Agent label used in the output.
 * @param source File path the config came from.
 */
export function serversFromConfig(json, agent, source) {
  if (json === null || typeof json !== 'object') return []
  const out = []
  const take = (group, label) => {
    if (group === null || typeof group !== 'object') return
    for (const [serverName, spec] of Object.entries(group)) {
      if (spec === null || typeof spec !== 'object') continue
      const command = [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])]
        .filter((part) => typeof part === 'string')
        .join(' ')
        .trim()
      out.push({ agent, source, serverName, command: command || spec.url || '', scope: label })
    }
  }
  take(json.mcpServers, 'global')
  take(json.servers, 'global')
  if (json.projects !== null && typeof json.projects === 'object') {
    for (const [project, value] of Object.entries(json.projects)) take(value?.mcpServers, project)
  }
  return out
}

/**
 * Match a declared server against the running process table.
 *
 * Matches on the command's first meaningful token (`npx`/`node` are skipped, so
 * `npx -y genoffice mcp` matches a `genoffice` process). Returns undefined when
 * nothing matches — never a guess, because a false match would report a server
 * as running when it is not.
 *
 * @param server {{command: string}}
 * @param processes {{command: string, rssMb: number, pid: number}[]}
 */
export function findProcess(server, processes) {
  const needles = needlesFor(server?.command)
  if (needles.length === 0) return undefined
  return processes.find((process) => {
    const tokens = process.command
      .split(/\s+/)
      .map((token) => token.replace(/^['"]|['"]$/g, '').split('/').pop())
    return tokens.some((token) => needles.includes(token))
  })
}

/** Words that identify no server in particular — matching on them matches everything. */
const GENERIC = new Set(['mcp', 'server', 'index.js', 'main.js', 'cli.js', 'app', 'run', 'start'])

/**
 * Binary names worth matching for one command line.
 *
 * Package specifiers are unwrapped so `npx -y @drawio/mcp` yields `drawio`, not
 * `mcp`. Dropping the generic word matters: an earlier version matched on `mcp`
 * and reported two unrelated servers as the same 47 MB process.
 *
 * @param command The declared server command.
 * @returns Candidate binary names, most specific first.
 */
export function needlesFor(command) {
  const PATH_WORDS = new Set(['bin', 'usr', 'local', 'lib', 'opt', 'sbin', 'share', 'Applications'])
  const tokens = String(command ?? '')
    .split(/\s+/)
    .filter((token) => token && !/^(-|npx$|node$|bunx?$|pnpm$|yarn$|uvx$|python3?$)/.test(token))
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
  const needles = []
  const add = (candidate) => {
    if (!candidate) return
    const clean = candidate.replace(/^@/, '')
    const lower = clean.toLowerCase()
    if (clean.length < 3 || GENERIC.has(lower) || PATH_WORDS.has(clean) || needles.includes(clean)) return
    needles.push(clean)
  }
  for (const token of tokens) {
    // A filesystem path contributes only its basename: the directories in it
    // (`bin`, `local`) are shared by every process on the machine.
    const isPath = token.startsWith('/') || token.startsWith('.') || token.split('/').length > 2
    const parts = token.split('/').filter(Boolean)
    if (isPath) {
      add(parts[parts.length - 1])
      continue
    }
    // An npm-style specifier (`@drawio/mcp`) contributes the package name too,
    // so a `mcp` binary is not the only thing we can match on.
    for (const part of parts) add(part)
  }
  return needles
}

/**
 * Total resident memory of a process and everything it spawned.
 *
 * A declared MCP command is usually a launcher: `/path/blender-mcp` is a shim
 * that execs a Python process, which loads Blender. Measuring only the shim
 * reported 2 MB for something using hundreds, so the honest number is the
 * subtree. Attribution is by ppid, which is why the process table has to carry
 * it.
 *
 * @param pid Root process.
 * @param processes Every process, each with pid/ppid/rssMb.
 */
export function subtreeCost(pid, processes) {
  const children = new Map()
  for (const process of processes) {
    const parent = process.ppid ?? 0
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(process)
  }
  let rssMb = 0
  let count = 0
  const stack = [pid]
  const seen = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    const process = processes.find((entry) => entry.pid === current)
    if (process) {
      rssMb += process.rssMb ?? 0
      count += 1
    }
    for (const child of children.get(current) ?? []) stack.push(child.pid)
  }
  return { rssMb: Math.round(rssMb * 10) / 10, processes: count }
}

/**
 * Turn observations into the printable report.
 *
 * @param servers Declared servers from every config found.
 * @param processes Running processes with rssMb.
 */
export function summarize(servers, processes) {
  const rows = servers.map((server) => {
    const process = findProcess(server, processes)
    const cost = process ? subtreeCost(process.pid, processes) : { rssMb: 0, processes: 0 }
    const rssMb = cost.rssMb
    const weight = guessWeight(server.command)
    return {
      ...server,
      running: process !== undefined,
      pid: process?.pid,
      rssMb,
      processCount: cost.processes,
      weight,
      ...verdict({ weight, running: process !== undefined, rssMb }),
    }
  })
  const lazy = rows.filter((row) => row.verdict === 'lazy-load')
  return {
    rows,
    totals: {
      declared: rows.length,
      running: rows.filter((row) => row.running).length,
      rssMb: Math.round(rows.reduce((sum, row) => sum + row.rssMb, 0)),
      lazyCandidates: lazy.length,
    },
  }
}
