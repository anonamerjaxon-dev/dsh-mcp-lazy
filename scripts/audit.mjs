#!/usr/bin/env node
/**
 * `npm run audit` — the pre-publish gate.
 *
 * Every rule here exists because this package shipped that defect once:
 *
 *   - a hard-coded `/Users/<name>/.nvm/...` path in index.js (worked on one
 *     machine, broke everywhere else);
 *   - a bundled cordis.patch.yml pointing at `/Users/<name>/.local/bin/genoffice`;
 *   - a `dsh.compatibility.dshReleases` map that DSH never reads, so the plugin
 *     looked version-managed while actually being compatible only by omission;
 *   - `private: true`, which silently makes `npm publish` refuse.
 *
 * Dependency-free on purpose: it must run before `npm install` on a clean CI
 * checkout. The YAML checks are therefore structural, not a full parse — they
 * catch the mistakes that actually happen, not every malformed document.
 *
 *   node scripts/audit.mjs        (exit 1 on any FAIL)
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let warnings = 0
const pass = (message) => console.log(`  PASS  ${message}`)
const fail = (message, fix) => {
  failures += 1
  console.log(`  FAIL  ${message}`)
  if (fix) console.log(`        fix: ${fix}`)
}
const warn = (message, hint) => {
  warnings += 1
  console.log(`  WARN  ${message}`)
  if (hint) console.log(`        ${hint}`)
}

const exists = async (rel) => {
  try {
    await stat(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

// ── the manifest ──────────────────────────────────────────────────────────
console.log('\nmanifest')
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

for (const field of ['name', 'version', 'description', 'license']) {
  if (typeof manifest[field] === 'string' && manifest[field].trim() !== '') pass(`${field} is set`)
  else fail(`${field} is missing or empty`)
}

if (manifest.private === true) {
  fail('"private": true blocks npm publish entirely', 'remove the field, or publish with a different mechanism')
} else {
  pass('not marked private')
}

// DSH's compatibility gate reads `engines.dsh` (or @deepseek-ai/dsh* peers) and
// nothing else — see unmetRequirements() in @deepseek-ai/dsh-app-boot.
if (typeof manifest.engines?.dsh === 'string') {
  pass(`engines.dsh declares the supported runtime range (${manifest.engines.dsh})`)
} else {
  fail(
    'no engines.dsh range: DSH treats an undeclared plugin as compatible with every release',
    'add engines.dsh, e.g. ">=0.2.1-rc.2 <0.3.0"',
  )
}
if (manifest.dsh?.compatibility !== undefined) {
  warn(
    'dsh.compatibility is present but DSH never reads it — it is decorative',
    'keep the real constraint in engines.dsh; delete dsh.compatibility so nobody trusts it',
  )
}

if (Array.isArray(manifest.files) && manifest.files.length > 0) pass(`files whitelist ships ${manifest.files.length} paths`)
else fail('no files whitelist: npm would ship tests, scripts and whatever else is lying around')

const targets = [
  manifest.main,
  ...Object.values(manifest.exports ?? {}).map((value) => (typeof value === 'string' ? value : value?.default)),
].filter((value) => typeof value === 'string')
for (const target of new Set(targets)) {
  if (await exists(target)) pass(`export target exists: ${target}`)
  else fail(`export target missing on disk: ${target}`)
}

// ── shipped contents ──────────────────────────────────────────────────────
console.log('\nshipped files')
// `files[]` may name a directory (bin, lib). Expand those, or the leak scan
// below would silently skip every file inside them — a directory read throws,
// and the scan treats a throw as "nothing to scan".
const shipped = []
const walk = async (rel) => {
  const info = await stat(path.join(root, rel)).catch(() => null)
  if (info === null) return
  if (info.isDirectory()) {
    for (const entry of await readdir(path.join(root, rel))) await walk(path.join(rel, entry))
    return
  }
  shipped.push(rel)
}
for (const entry of manifest.files ?? []) {
  if (await exists(entry)) await walk(entry)
  else fail(`files[] lists a path that does not exist: ${entry}`)
}
for (const required of ['README.md', 'LICENSE']) {
  if (!shipped.includes(required)) fail(`${required} is not in files[] — nobody installs an undocumented, unlicensed package`)
  else pass(`ships ${required}`)
}
if (manifest.license === 'MIT' && !shipped.includes('LICENSE')) {
  fail('LICENSE is claimed as MIT but not shipped')
}
pass(`${shipped.length} shipped path(s) all exist`)

// ── leak scan ─────────────────────────────────────────────────────────────
console.log('\nleak scan (machine paths, credentials)')
const ABSOLUTE = [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//, /[A-Za-z]:\\Users\\/, /\/nvm\/versions\/node\//]
const SECRETS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

let scanned = 0
for (const rel of shipped) {
  let text
  try {
    text = await readFile(path.join(root, rel), 'utf8')
  } catch {
    continue // LICENSE-style binary or unreadable: nothing to scan
  }
  scanned += 1
  text.split('\n').forEach((line, index) => {
    for (const pattern of ABSOLUTE) {
      if (!pattern.test(line)) continue
      fail(
        `${rel}:${index + 1} hard-codes a machine path — breaks on every other install`,
        line.trim().slice(0, 100),
      )
      break
    }
    for (const pattern of SECRETS) {
      if (!pattern.test(line)) continue
      fail(`${rel}:${index + 1} looks like a credential`)
      break
    }
  })
}
if (scanned > 0) pass(`scanned ${scanned} shipped text file(s) for absolute paths and credentials`)

// ── the bundle patch ──────────────────────────────────────────────────────
console.log('\nbundle patch')
const patchRel = manifest.dsh?.bundle?.patch
if (typeof patchRel !== 'string') {
  fail('dsh.bundle.patch is not declared: nothing would mount the plugin')
} else if (!(await exists(patchRel))) {
  fail(`dsh.bundle.patch points at a missing file: ${patchRel}`)
} else {
  const lines = (await readFile(path.join(root, patchRel), 'utf8')).split('\n')
  const rows = []
  lines.forEach((line, index) => {
    if (!/^\s*-\s+id:\s*\S+/.test(line)) return
    const id = line.split(':').slice(1).join(':').trim()
    const nameLine = lines.slice(index, index + 3).find((candidate) => /^\s*name:\s*\S+/.test(candidate))
    const rowName = nameLine?.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '')
    rows.push({ line: index, id, rowName })
  })
  if (rows.length === 0) fail(`${patchRel} inserts no row: the plugin would never load`)
  for (const row of rows) {
    const window = lines.slice(row.line, row.line + 3).join('\n')
    if (!/^\s*name:\s*\S+/m.test(window)) fail(`${patchRel}:${row.line + 1} row "${row.id}" has no name:`)
  }
  if (rows.length > 0) pass(`${rows.length} insert row(s), each with an id and a name`)
  // A bundle that does not name its own package cannot mount itself. This also
  // catches the rename drift that bit this repo: package.json renamed, patch
  // still naming the old one, and the row silently fails to resolve.
  if (rows.length > 0 && !rows.some((row) => row.rowName === manifest.name)) {
    fail(
      `${patchRel} never names the package itself (${manifest.name}) — the bundle would mount nothing`,
      `one row needs name: '${manifest.name}'`,
    )
  } else if (rows.length > 0) {
    pass(`a row mounts ${manifest.name} by name`)
  }

  const servers = lines.filter((line) => /^\s*-\s+serverName:\s*\S+/.test(line))
  for (const line of servers) {
    const at = lines.indexOf(line)
    const spec = lines.slice(at, at + 6).join('\n')
    const name = line.split(':').slice(1).join(':').trim()
    if (!/transport:\s*\S+/.test(spec)) fail(`${patchRel}:${at + 1} server "${name}" declares no transport`)
    if (!/(command|url):\s*\S+/.test(spec)) fail(`${patchRel}:${at + 1} server "${name}" has neither command nor url`)
  }
  if (servers.length > 0) pass(`${servers.length} server spec(s), each with a transport and an endpoint`)
  else warn('the patch ships no default server', 'fine for a general-purpose release; the installer supplies servers[] themselves')
}

// ── code hygiene ──────────────────────────────────────────────────────────
console.log('\ncode hygiene')
const entry = manifest.main ?? 'index.js'
const source = await readFile(path.join(root, entry), 'utf8')
if (/\bconsole\.(log|warn|error)\(/.test(source)) {
  fail(`${entry} writes to the console directly`, 'use ctx.logger so output respects the host log level')
} else {
  pass(`${entry} logs through ctx.logger, never the console`)
}
if (source.includes('export function resolveMcpClient')) pass('host resolution is a named, testable function')
else warn('resolveMcpClient is not exported: host resolution cannot be tested or overridden')

if (await exists('test.mjs')) pass('test.mjs is present')
else fail('no test suite: nothing proves the idle-release rules still hold')

const pkgScripts = manifest.scripts ?? {}
for (const name of ['test', 'check']) {
  if (typeof pkgScripts[name] === 'string') pass(`npm run ${name} is wired`)
  else fail(`no "${name}" script: the gate cannot run the same way everywhere`)
}

// ── verdict ───────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${failures} failure(s), ${warnings} warning(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
