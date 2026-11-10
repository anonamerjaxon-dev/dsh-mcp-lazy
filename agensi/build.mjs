#!/usr/bin/env node
/**
 * `npm run agensi:build` — pack the skill for submission.
 *
 * Agensi wants "a zip file containing a valid SKILL.md file with the required
 * frontmatter fields", where `name:` must match the containing folder. So the
 * archive has to be inspected, not just produced: a zip with SKILL.md at the
 * root instead of inside `lazy-mcp-loading/` fails their structure check.
 *
 *   node agensi/build.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.join(here, 'lazy-mcp-loading')
const distDir = path.join(here, 'dist')

const source = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
const front = source.match(/^---\n([\s\S]*?)\n---\n/)
if (!front) throw new Error('SKILL.md does not start with a --- frontmatter block')

const field = (key) => front[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
const name = field('name')
const description = field('description')

if (!name) throw new Error('SKILL.md frontmatter has no name')
if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`name must be lowercase letters, digits and hyphens: ${name}`)
if (name !== path.basename(skillDir)) {
  throw new Error(`name "${name}" must equal the folder name "${path.basename(skillDir)}"`)
}
if (!description) throw new Error('SKILL.md frontmatter has no description')
if (!/Use when/i.test(description)) {
  console.warn('warning: the description has no "Use when ..." trigger sentence — activation will be weaker')
}

const entries = await readdir(skillDir, { recursive: true })
for (const entry of entries) {
  if (/\.(sh|py|js|mjs|cjs|exe|bin|dmg|pkg)$/.test(entry)) {
    throw new Error(`refusing to ship executable content: ${entry} (Agensi's scan flags it)`)
  }
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })
const zip = path.join(distDir, `${name}-1.0.0.zip`)
execFileSync('zip', ['-qr', zip, path.basename(skillDir)], { cwd: here, stdio: 'pipe' })

const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n')
console.log(`\ncreated ${path.relative(process.cwd(), zip)}`)
console.log('contents:')
for (const line of listing) console.log(`  ${line}`)

const expected = `${path.basename(skillDir)}/SKILL.md`
if (!listing.includes(expected)) throw new Error(`archive must contain ${expected} at its root level`)
console.log(`\nPASS  ${expected} is at the archive root; name matches the folder`)
console.log(`      title: ${name}`)
console.log(`      chars in description: ${description.length}\n`)
