// Building a pack.
//
// Ordering is the safety property: the entire pack is built in memory, scanned, and shown
// to the author before a single byte reaches the disk. Write-then-ask would mean a pack the
// author rejected still exists in a directory they might later publish by accident.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { expand } from './config.mjs'
import { generateFixture } from './fixtures.mjs'
import { stripFile, UnsupportedLanguageError } from './interfaces.mjs'
import { countBySeverity, hasBlockingFindings, scanText, SEVERITY_ORDER } from './scan.mjs'

export const VERBATIM = 'verbatim'
export const STRIPPED = 'stripped'
export const FIXTURE = 'fixture'

/** Apply the author's redact rules, reporting which ones actually fired. */
export function applyRedactions(text, rules) {
  let out = text
  const applied = []
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    let hits = 0
    out = out.replace(re, () => {
      hits++
      return rule.replace
    })
    if (hits) applied.push({ pattern: rule.source, hits })
  }
  return { text: out, applied }
}

function allowKey(finding) {
  return [
    `${finding.ruleId}:${finding.path}:${finding.line}`,
    `${finding.ruleId}:${finding.path}`,
    `${finding.ruleId}:*`,
  ]
}

function partitionFindings(findings, allowList) {
  const allowed = new Set(allowList)
  const active = []
  const suppressed = []
  for (const finding of findings) {
    if (allowKey(finding).some((k) => allowed.has(k))) suppressed.push(finding)
    else active.push(finding)
  }
  return { active, suppressed }
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Build the pack in memory.
 * @returns {{files: Array, findings: Array, suppressed: Array, warnings: string[]}}
 */
export async function buildPack(root, config) {
  const files = []
  const warnings = [...(config.warnings ?? [])]

  const [includes, interfaces, tests] = await Promise.all([
    expand(root, config.include, 'include'),
    expand(root, config.interfaces, 'interfaces'),
    expand(root, config.tests, 'tests'),
  ])

  const claimed = new Map()
  const claim = (path, kind) => {
    if (claimed.has(path)) {
      warnings.push(
        `"${path}" is listed under both "${claimed.get(path)}" and "${kind}". ` +
          `Using "${claimed.get(path)}" — remove the duplicate to make the intent explicit.`,
      )
      return false
    }
    claimed.set(path, kind)
    return true
  }

  for (const path of includes) {
    if (!claim(path, 'include')) continue
    files.push({ path, kind: VERBATIM, source: await readFile(join(root, path), 'utf8'), notes: [] })
  }

  for (const path of interfaces) {
    if (!claim(path, 'interfaces')) continue
    const original = await readFile(join(root, path), 'utf8')
    let stripped
    try {
      stripped = stripFile(original, path)
    } catch (err) {
      if (err instanceof UnsupportedLanguageError) throw err
      throw new Error(`failed to strip "${path}": ${err.message}`)
    }
    files.push({
      path,
      kind: STRIPPED,
      source: stripped.code,
      originalBytes: Buffer.byteLength(original),
      notes: stripped.warnings,
      dropped: stripped.dropped,
    })
  }

  for (const path of tests) {
    if (!claim(path, 'tests')) continue
    files.push({ path, kind: VERBATIM, isTest: true, source: await readFile(join(root, path), 'utf8'), notes: [] })
  }

  for (const { path, spec } of config.fixtures) {
    if (!claim(path, 'fixtures')) continue
    const original = await readIfExists(join(root, path))
    files.push({
      path,
      kind: FIXTURE,
      spec,
      source: generateFixture(spec, original, path),
      originalBytes: original === null ? null : Buffer.byteLength(original),
      notes: [],
    })
  }

  // Redact first, then scan. Scanning before redaction would report findings the author
  // already handled; scanning after is the only way to know the redactions were enough.
  const findings = []
  for (const file of files) {
    const { text, applied } = applyRedactions(file.source, config.redact)
    file.source = text
    file.redactions = applied
    file.bytes = Buffer.byteLength(text)
    findings.push(...scanText(text, { path: file.path, customRules: config.scanRules }))
  }

  const { active, suppressed } = partitionFindings(findings, config.allowFindings)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, findings: active, suppressed, warnings }
}

export function buildManifest(config, { files, findings, suppressed, warnings }) {
  return {
    sparepackVersion: 1,
    task: config.task,
    generated: {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    },
    files: files.map((f) => ({
      path: f.path,
      kind: f.kind,
      bytes: f.bytes,
      ...(f.isTest ? { role: 'acceptance-test' } : {}),
      ...(f.spec ? { generator: f.spec } : {}),
      ...(f.originalBytes != null ? { originalBytes: f.originalBytes } : {}),
      ...(f.redactions?.length ? { redactions: f.redactions } : {}),
      ...(f.notes?.length ? { notes: f.notes } : {}),
    })),
    findings: findings.map((f) => ({
      rule: f.ruleId,
      severity: f.severity,
      label: f.label,
      path: f.path,
      line: f.line,
      excerpt: f.excerpt,
    })),
    suppressedFindings: suppressed.length,
    warnings,
  }
}

/** The human-readable report. This is the thing the author is asked to approve. */
export function renderManifest(manifest, { color = false } = {}) {
  const bold = (s) => (color ? `[1m${s}[0m` : s)
  const dim = (s) => (color ? `[2m${s}[0m` : s)
  const red = (s) => (color ? `[31m${s}[0m` : s)
  const yellow = (s) => (color ? `[33m${s}[0m` : s)

  const lines = []
  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

  lines.push('')
  lines.push(bold('Task'))
  lines.push(`  ${manifest.task}`)
  lines.push('')
  lines.push(bold(`Files to publish (${manifest.files.length}, ${kb(manifest.generated.bytes)})`))

  const label = { [VERBATIM]: 'verbatim ', [STRIPPED]: 'stripped ', [FIXTURE]: 'fixture  ' }
  for (const f of manifest.files) {
    const role = f.role === 'acceptance-test' ? dim('  [spec]') : ''
    const shrink =
      f.originalBytes != null && f.originalBytes > 0
        ? dim(`  ${kb(f.originalBytes)} → ${kb(f.bytes)}`)
        : dim(`  ${kb(f.bytes)}`)
    lines.push(`  ${label[f.kind] ?? f.kind} ${f.path}${shrink}${role}`)
    if (f.generator) lines.push(dim(`             generator: ${f.generator}`))
    for (const r of f.redactions ?? []) lines.push(dim(`             redacted /${r.pattern}/ ×${r.hits}`))
    for (const n of f.notes ?? []) lines.push(yellow(`             ${n}`))
  }

  if (manifest.warnings.length) {
    lines.push('')
    lines.push(bold('Warnings'))
    for (const w of manifest.warnings) lines.push(yellow(`  ${w}`))
  }

  lines.push('')
  if (manifest.findings.length) {
    const counts = countBySeverity(manifest.findings.map((f) => ({ severity: f.severity })))
    const summary = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ')
    lines.push(bold(red(`Scan findings (${summary})`)))
    for (const f of manifest.findings) {
      const line = `  ${f.severity.padEnd(8)} ${f.path}:${f.line}  ${f.label}  ${f.excerpt}`
      lines.push(['critical', 'high'].includes(f.severity) ? red(line) : yellow(line))
    }
    lines.push(dim('  (excerpts are masked — the scanner never prints what it found in full)'))
  } else {
    lines.push(bold('Scan findings: none'))
  }
  if (manifest.suppressedFindings) {
    lines.push(dim(`  ${manifest.suppressedFindings} finding(s) suppressed by allowFindings`))
  }

  return lines.join('\n')
}

/** Generate the README a worker sees first. */
function packReadme(manifest) {
  const tests = manifest.files.filter((f) => f.role === 'acceptance-test')
  const stripped = manifest.files.filter((f) => f.kind === STRIPPED)
  const fixtures = manifest.files.filter((f) => f.kind === FIXTURE)

  return `# Task pack

${manifest.task}

## What you are looking at

This is a **sparepack**: a redacted slice of a private repository, containing the contract
and nothing else. The business logic is not here and is not supposed to be.

${
  stripped.length
    ? `### Interfaces (${stripped.length})

Signatures and types only. Every function body throws \`sparepack stub: not implemented\`.
Your job is to replace those bodies.

${stripped.map((f) => `- \`${f.path}\``).join('\n')}
`
    : ''
}${
    tests.length
      ? `### Acceptance tests (${tests.length})

**These are the specification.** Not a suggestion, not a starting point — if they pass, the
task is done. If something about the intended behaviour is not expressed in them, say so
rather than guessing.

${tests.map((f) => `- \`${f.path}\``).join('\n')}
`
      : `### No acceptance tests

This pack ships no tests, so "done" is defined in prose only. Ask the requester what
passing looks like before you start.
`
  }${
    fixtures.length
      ? `### Fixtures (${fixtures.length})

Synthetic data with the same shape as the real thing. Structure is accurate, values are not.

${fixtures.map((f) => `- \`${f.path}\` (${f.generator})`).join('\n')}
`
      : ''
  }
## Working on this

1. Make the acceptance tests pass.
2. Do not weaken a test to make it pass. If a test looks wrong, raise it — that is useful
   feedback and it is the requester's call, not yours.
3. Deliver a patch against this pack's layout.

## What is not here

Anything the requester did not explicitly list. Missing context is not an oversight to route
around — if you cannot complete the task without seeing more, ask. Reconstructing the
surrounding system by guessing produces code that fits nothing.
`
}

/**
 * Strip the manifest down to what may safely travel with the pack.
 *
 * The full manifest is an audit record for the author and it is full of the very things the
 * pack exists to withhold: warnings naming dropped internal functions ("internal function
 * applyLoyaltyTierDiscount dropped"), and the redact patterns, which are literally a list of
 * the words that must not be seen. Shipping it would undo the work. The published copy keeps
 * only what `verify` needs to detect tampering: paths, kinds, and sizes.
 */
export function toPublicManifest(manifest) {
  return {
    sparepackVersion: manifest.sparepackVersion,
    task: manifest.task,
    generated: manifest.generated,
    files: manifest.files.map((f) => ({
      path: f.path,
      kind: f.kind,
      bytes: f.bytes,
      ...(f.role ? { role: f.role } : {}),
      ...(f.generator ? { generator: f.generator } : {}),
    })),
  }
}

/** Write an approved pack to disk. Only ever called after the author has confirmed. */
export async function writePack(outDir, manifest, files) {
  const out = resolve(outDir)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  for (const file of files) {
    const dest = join(out, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.source)
  }

  await writeFile(join(out, 'MANIFEST.json'), `${JSON.stringify(toPublicManifest(manifest), null, 2)}\n`)
  await writeFile(join(out, 'README.md'), packReadme(manifest))
  return out
}

export { hasBlockingFindings }
