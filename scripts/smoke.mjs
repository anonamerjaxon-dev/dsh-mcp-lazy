#!/usr/bin/env node
/**
 * `npm run smoke` — prove the packed package works *outside this checkout*.
 *
 * The audit reads files; this one installs them. It packs the tarball, extracts
 * it, drops it into a fake profile's node_modules, and imports it from there.
 * That is the only way to catch a defect the unit tests cannot see: everything
 * resolving because the code sits next to its own source tree.
 *
 * Two outcomes are both correct and both get asserted:
 *
 *   - a DSH installation is found  → resolveMcpClient() returns a real path;
 *   - none is found (CI)           → it throws the documented, explicit error
 *                                    naming every candidate it tried.
 *
 * What is NOT acceptable — and what this script exists to catch — is the third
 * outcome: a silent hard-coded path that "works" on the author's machine.
 *
 *   node scripts/smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-lazy-smoke-'))
let failures = 0
const pass = (message) => console.log(`  PASS  ${message}`)
const fail = (message, detail) => {
  failures += 1
  console.log(`  FAIL  ${message}`)
  if (detail) console.log(`        ${detail}`)
}

try {
  // ── pack ────────────────────────────────────────────────────────────────
  console.log('\npack')
  execFileSync('npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: root, stdio: 'pipe' })
  const tgz = (await readdir(tmp)).find((file) => file.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack produced no tarball')
  pass(`packed ${tgz}`)

  const unpacked = path.join(tmp, 'unpacked')
  await mkdir(unpacked, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', unpacked], { stdio: 'pipe' })
  const packageDir = path.join(unpacked, 'package')

  // ── the tarball says what it is ──────────────────────────────────────────
  console.log('\ntarball contents')
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  const files = await readdir(packageDir)
  for (const required of ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (files.includes(required)) pass(`ships ${required}`)
    else fail(`tarball is missing ${required}`)
  }
  for (const unwanted of ['test.mjs', 'scripts', 'node_modules', '.git']) {
    if (!files.includes(unwanted)) pass(`excludes ${unwanted}`)
    else fail(`tarball ships ${unwanted}`)
  }
  if (manifest.private !== true) pass('publishable: not marked private')
  else fail('"private": true is in the packed manifest; npm publish would refuse')

  // ── no machine paths survive packing ─────────────────────────────────────
  console.log('\nextracted files are machine-independent')
  for (const file of ['index.js', 'cordis.patch.yml']) {
    const text = await readFile(path.join(packageDir, file), 'utf8')
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)) fail(`${file} still contains an absolute home path after packing`)
    else pass(`${file} has no absolute home path`)
  }

  // ── install into a fake profile and run it ───────────────────────────────
  console.log('\nloads from a profile node_modules')
  const profileDir = path.join(tmp, 'profile')
  const installed = path.join(profileDir, 'node_modules', manifest.name)
  await mkdir(path.dirname(installed), { recursive: true })
  await cp(packageDir, installed, { recursive: true })

  const probe = path.join(profileDir, 'probe.mjs')
  await writeFile(
    probe,
    [
      `import { name, resolveMcpClient } from './node_modules/${manifest.name}/index.js'`,
      'let outcome',
      'try { outcome = { ok: true, resolved: resolveMcpClient() } }',
      'catch (error) { outcome = { ok: false, message: String(error.message) } }',
      'console.log(JSON.stringify({ name, ...outcome }))',
    ].join('\n'),
  )

  const env = { ...process.env }
  delete env.DSH_HOST_PKG // the override is not allowed to rescue this test
  const raw = execFileSync(process.execPath, [probe], { cwd: profileDir, env, encoding: 'utf8' }).trim()
  const result = JSON.parse(raw.split('\n').pop())

  if (result.name === 'mcp-lazy') pass('the installed copy imports and names itself')
  else fail(`unexpected plugin name: ${JSON.stringify(result.name)}`)

  if (result.ok === true && /dsh-mcp-client/.test(result.resolved)) {
    pass(`resolves the host client from a foreign location: ${result.resolved}`)
  } else if (result.ok === false && /cannot locate @deepseek-ai\/dsh-mcp-client/.test(result.message)) {
    pass('no DSH on this machine — it fails loudly with the documented message instead of guessing')
  } else {
    fail('host resolution did not behave as documented', raw.slice(0, 400))
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${failures} failure(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
