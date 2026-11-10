#!/usr/bin/env node
/**
 * Tests for the portable audit logic (lib/lazy-audit.mjs).
 *
 * Kept separate from test.mjs because these rules answer a different question:
 * test.mjs proves the DSH plugin releases servers safely, this proves the audit
 * tells the truth about what is running. A wrong match here would report a
 * server as resident when it is not, and send someone rewriting a config that
 * was never the problem.
 *
 *   node test-audit.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const M = await import(path.join(here, 'lib/lazy-audit.mjs'))

let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

console.log('\nweight')
check('a GUI application is heavy', () => assert.equal(M.guessWeight('genoffice mcp'), 'heavy'))
check('a browser server is heavy', () => assert.equal(M.guessWeight('npx -y @playwright/mcp'), 'heavy'))
check('a database server is heavy', () => assert.equal(M.guessWeight('docker run postgres'), 'heavy'))
check('a small filesystem server is light', () => assert.equal(M.guessWeight('npx -y @modelcontextprotocol/server-filesystem /tmp'), 'light'))
check('an empty command is light, not a crash', () => assert.equal(M.guessWeight(undefined), 'light'))

console.log('\nverdict')
check('not running means nothing to fix', () => {
  const v = M.verdict({ weight: 'heavy', running: false })
  assert.equal(v.verdict, 'idle')
})
check('a heavy server that is running is the candidate', () =>
  assert.equal(M.verdict({ weight: 'heavy', running: true, rssMb: 157 }).verdict, 'lazy-load'))
check('measured size outranks the name-based guess', () =>
  assert.equal(M.verdict({ weight: 'light', running: true, rssMb: 220 }).verdict, 'lazy-load'))
check('a light server that is running stays resident', () =>
  assert.equal(M.verdict({ weight: 'light', running: true, rssMb: 12 }).verdict, 'keep'))
check('a heavy-sounding name at a trivial size is left alone', () =>
  assert.equal(M.verdict({ weight: 'heavy', running: true, rssMb: 2 }).verdict, 'keep'))
check('the detail quotes the measured size', () =>
  assert.match(M.verdict({ weight: 'heavy', running: true, rssMb: 157 }).detail, /157 MB/))

console.log('\nDSH patch parsing')
check('reads a serverName and its command', () => {
  const servers = M.parseDshPatchServers(`
        servers:
          - serverName: genoffice
            allowPresets: [office]
            transport: stdio
            command: genoffice
            args: [mcp]
`)
  assert.equal(servers.length, 1)
  assert.equal(servers[0].serverName, 'genoffice')
  assert.equal(servers[0].command, 'genoffice')
  assert.equal(servers[0].transport, 'stdio')
})
check('strips quotes from the command', () => {
  const [server] = M.parseDshPatchServers('          - serverName: x\n            command: "/usr/bin/x mcp"')
  assert.equal(server.command, '/usr/bin/x mcp')
})
check('invents nothing when the patch has no servers', () =>
  assert.deepEqual(M.parseDshPatchServers('- insert:\n    - id: mcp-lazy'), []))
check('reads the mapping-key shape an edited profile uses', () => {
  const servers = M.parseDshPatchServers(`
          - id: mcp-genoffice
            name: '@deepseek-ai/dsh-mcp-client'
            disabled: true
            config:
              serverName: genoffice
              transport: stdio
              command: /x/genoffice
`)
  assert.equal(servers.length, 1)
  assert.equal(servers[0].serverName, 'genoffice')
  assert.equal(servers[0].disabled, true)
  assert.equal(servers[0].command, '/x/genoffice')
})
check('an active row is not marked disabled', () => {
  const [server] = M.parseDshPatchServers('          - serverName: live\n            command: live')
  assert.equal(server.disabled, false)
})

console.log('\nJSON config parsing')
check('reads the mcpServers shape (Claude Code, Cursor)', () => {
  const servers = M.serversFromConfig({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } }, 'Cursor', '/x')
  assert.equal(servers.length, 1)
  assert.equal(servers[0].command, 'npx -y server-fs')
})
check('reads the servers shape (VS Code)', () => {
  const servers = M.serversFromConfig({ servers: { pg: { command: 'docker', args: ['run', 'postgres'] } } }, 'VS Code', '/x')
  assert.equal(servers[0].serverName, 'pg')
})
check('reads Claude Code per-project blocks', () => {
  const servers = M.serversFromConfig({ projects: { '/repo': { mcpServers: { a: { command: 'a' } } } } }, 'Claude Code', '/x')
  assert.equal(servers.length, 1)
  assert.equal(servers[0].scope, '/repo')
})
check('a url-based server keeps its url as the command', () => {
  const [server] = M.serversFromConfig({ mcpServers: { remote: { url: 'https://example.org/mcp' } } }, 'Cursor', '/x')
  assert.equal(server.command, 'https://example.org/mcp')
})
check('null and rubbish return an empty list, not a throw', () => {
  assert.deepEqual(M.serversFromConfig(null, 'x', 'y'), [])
  assert.deepEqual(M.serversFromConfig({ mcpServers: { broken: 'nope' } }, 'x', 'y'), [])
})

console.log('\nprocess matching')
check('skips npx and matches the real binary', () => {
  const server = { command: 'npx -y genoffice mcp' }
  const found = M.findProcess(server, [{ pid: 7, rssMb: 157, command: 'node /usr/local/bin/genoffice mcp' }])
  assert.equal(found?.pid, 7)
})
check('never matches on a bare interpreter name', () => {
  const found = M.findProcess({ command: 'node server.js' }, [{ pid: 1, rssMb: 40, command: 'node something-else' }])
  assert.equal(found, undefined)
})
check('no match is undefined, never a guess', () =>
  assert.equal(M.findProcess({ command: 'npx -y playwright mcp' }, [{ pid: 1, rssMb: 9, command: 'node other' }]), undefined))
check('a full path still matches its basename', () => {
  const found = M.findProcess({ command: '/Users/x/.local/bin/genoffice mcp' }, [{ pid: 3, rssMb: 150, command: 'genoffice mcp' }])
  assert.equal(found?.pid, 3)
})

console.log('\nsummary')
{
  const servers = [
    { agent: 'DSH', source: '/a', serverName: 'genoffice', command: 'genoffice mcp' },
    { agent: 'Cursor', source: '/b', serverName: 'fs', command: 'npx -y server-fs' },
    { agent: 'Cursor', source: '/b', serverName: 'playwright', command: 'npx -y playwright mcp' },
  ]
  const processes = [
    { pid: 10, rssMb: 157, command: 'genoffice mcp' },
    { pid: 11, rssMb: 12, command: 'node /x/server-fs' },
  ]
  const report = M.summarize(servers, processes)
  check('counts what is declared and what is running', () => {
    assert.equal(report.totals.declared, 3)
    assert.equal(report.totals.running, 2)
  })
  check('sums resident memory of the running ones only', () => assert.equal(report.totals.rssMb, 169))
  check('flags exactly the heavy running server', () => {
    assert.deepEqual(report.rows.filter((row) => row.verdict === 'lazy-load').map((row) => row.serverName), ['genoffice'])
  })
  check('an unstarted heavy server is idle, not a candidate', () => {
    const playwright = report.rows.find((row) => row.serverName === 'playwright')
    assert.equal(playwright.verdict, 'idle')
  })
}

console.log(`\n${passed} checks passed\n`)
