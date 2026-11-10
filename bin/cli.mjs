#!/usr/bin/env node
/**
 * Entry point so the portable command works without DSH:
 *
 *   npx dsh-lazy-mcp audit
 *   npx dsh-lazy-mcp audit --json
 *   npx dsh-lazy-mcp            (same as `audit`)
 *
 * The plugin itself is loaded by DSH from the bundle patch and never goes
 * through this file — this is only the part that has to run anywhere.
 */

const [, , command, ...rest] = process.argv

const USAGE = `
dsh-lazy-mcp — lazy MCP server loading

  dsh-lazy-mcp audit [--json] [--cwd PATH]
      Report every MCP server your agents declare, which are actually running,
      and which are costing memory for no reason. Read-only.

  dsh-lazy-mcp help
      This text.

The DSH plugin (idle release, preset gating) mounts automatically from the
bundle patch; it has no CLI. Docs: github.com/anonamerjaxon-dev/dsh-mcp-lazy
`

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE)
  process.exit(0)
}

if (command === undefined || command === '--json' || command === '--cwd' || command === 'audit') {
  // Re-expose the arguments the audit module expects: it reads argv.slice(2).
  process.argv = [process.argv[0], process.argv[1], ...(command === 'audit' ? rest : [command, ...rest])]
  await import('./audit.mjs')
} else {
  console.error(`Unknown command: ${command}`)
  console.log(USAGE)
  process.exit(1)
}
