// Loading and validating sparepack.yaml.
//
// The config is an allowlist and only an allowlist. There is deliberately no `exclude`
// key: "ship everything except these" is the shape that leaks, because a file you forgot
// to think about defaults to being published. Here, a file you forgot about stays home.

import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'

import { compileCustomRule } from './scan.mjs'

export const CONFIG_NAMES = ['sparepack.yaml', 'sparepack.yml']

const FILE_KEYS = ['include', 'interfaces', 'tests']
const KNOWN_KEYS = new Set([...FILE_KEYS, 'task', 'fixtures', 'redact', 'scanRules', 'allowFindings', 'out'])

class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message)
}

function asArray(value, key) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`"${key}" must be a list`)
  return value
}

/**
 * Reject anything that would resolve outside the repository root.
 * Absolute paths, `..` traversal, and symlink escapes all land here.
 */
export function assertInsideRoot(root, candidate, what = 'path') {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    fail(`${what} "${candidate}" resolves outside the repository root`)
  }
  return resolved
}

function validatePattern(pattern, key) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    fail(`"${key}" entries must be non-empty strings`)
  }
  if (isAbsolute(pattern)) {
    fail(`"${key}" entry "${pattern}" must be relative to the repository root, not absolute`)
  }
  if (pattern.split(/[\\/]/).includes('..')) {
    fail(`"${key}" entry "${pattern}" must not contain ".."`)
  }
  return pattern
}

function parseRedact(raw) {
  return asArray(raw, 'redact').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      fail(`redact[${i}] must be a mapping with "pattern" and "replace"`)
    }
    if (typeof entry.pattern !== 'string' || !entry.pattern) {
      fail(`redact[${i}].pattern must be a non-empty string`)
    }
    if (typeof entry.replace !== 'string') {
      fail(`redact[${i}].replace must be a string (use "" to delete)`)
    }
    let re
    try {
      re = new RegExp(entry.pattern, entry.flags ?? 'g')
    } catch (err) {
      fail(`redact[${i}]: invalid regex — ${err.message}`)
    }
    if (!re.global) re = new RegExp(re.source, `${re.flags}g`)
    return { source: entry.pattern, re, replace: entry.replace }
  })
}

function parseFixtures(raw) {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('"fixtures" must be a mapping of path -> generator')
  }
  return Object.entries(raw).map(([path, spec]) => {
    validatePattern(path, 'fixtures')
    if (typeof spec !== 'string' || !spec.trim()) {
      fail(`fixtures["${path}"] must be a non-empty generator string`)
    }
    return { path, spec: spec.trim() }
  })
}

/** Parse config text. Separated from disk access so tests need no fixtures on disk. */
export function parseConfig(text, { source = 'sparepack.yaml' } = {}) {
  let raw
  try {
    raw = parse(text)
  } catch (err) {
    fail(`${source} is not valid YAML — ${err.message}`)
  }
  if (raw === null || raw === undefined) fail(`${source} is empty`)
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${source} must be a mapping at the top level`)

  if ('exclude' in raw) {
    fail(
      'sparepack has no "exclude" key, by design. Denylists leak: a file nobody thought ' +
        'about ends up published. List what you want to expose under include/interfaces/tests instead.',
    )
  }

  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'))
  if (unknown.length) {
    fail(`unknown key(s) in ${source}: ${unknown.join(', ')} (prefix a key with "_" for notes)`)
  }

  if (typeof raw.task !== 'string' || !raw.task.trim()) {
    fail('"task" is required: one line saying what this pack is for. The worker reads it first.')
  }

  const config = {
    task: raw.task.trim(),
    out: typeof raw.out === 'string' && raw.out.trim() ? raw.out.trim() : 'sparepack-out',
    include: asArray(raw.include, 'include').map((p) => validatePattern(p, 'include')),
    interfaces: asArray(raw.interfaces, 'interfaces').map((p) => validatePattern(p, 'interfaces')),
    tests: asArray(raw.tests, 'tests').map((p) => validatePattern(p, 'tests')),
    fixtures: parseFixtures(raw.fixtures),
    redact: parseRedact(raw.redact),
    scanRules: asArray(raw.scanRules, 'scanRules').map(compileCustomRule),
    allowFindings: asArray(raw.allowFindings, 'allowFindings').map((entry, i) => {
      if (typeof entry !== 'string' || !entry.includes(':')) {
        fail(`allowFindings[${i}] must look like "rule-id:path" or "rule-id:path:line"`)
      }
      return entry
    }),
  }

  validatePattern(config.out, 'out')

  const total = FILE_KEYS.reduce((n, key) => n + config[key].length, 0)
  if (total === 0) {
    fail('nothing to pack: list at least one file under include, interfaces, or tests')
  }
  if (config.tests.length === 0) {
    // Not fatal — some packs are pure interface handoffs — but it is nearly always a mistake.
    config.warnings = [
      'no "tests" listed. Tests are how a worker knows what "done" means; without them ' +
        'the acceptance criteria live only in prose and disputes get expensive.',
    ]
  } else {
    config.warnings = []
  }

  return config
}

/** Expand a glob pattern to repo-relative file paths, rejecting anything outside root. */
export async function expand(root, patterns, key) {
  const seen = new Set()
  for (const pattern of patterns) {
    let matched = 0
    for await (const entry of glob(pattern, { cwd: root, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const abs = resolve(entry.parentPath ?? entry.path, entry.name)
      assertInsideRoot(root, relative(root, abs), `${key} match`)
      seen.add(relative(root, abs))
      matched++
    }
    if (matched === 0) {
      fail(`"${key}" pattern "${pattern}" matched no files. A typo here means silently shipping less than you meant to.`)
    }
  }
  return [...seen].sort()
}

export async function loadConfig(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') fail(`no config at ${path} — run "sparepack init" first`)
    throw err
  }
  return parseConfig(text, { source: path })
}

export { ConfigError }
