import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertInsideRoot, ConfigError, parseConfig } from '../src/config.mjs'

const base = 'task: "do a thing"\ninclude:\n  - src/a.ts\n'

const bad = (yaml, pattern) => {
  assert.throws(() => parseConfig(yaml), (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}: ${err.message}`)
    assert.match(err.message, pattern)
    return true
  })
}

// --- the allowlist rule ---------------------------------------------------

test('"exclude" is rejected with an explanation, not silently ignored', () => {
  bad(`${base}exclude:\n  - secrets.ts\n`, /no "exclude" key, by design/)
})

test('a config that lists nothing is rejected', () => {
  bad('task: "do a thing"\n', /nothing to pack/)
})

test('a config with only fixtures still counts as listing nothing', () => {
  bad('task: "x"\nfixtures:\n  data/a.json: shape\n', /nothing to pack/)
})

// --- path safety ----------------------------------------------------------

test('absolute paths are rejected', () => {
  bad('task: "x"\ninclude:\n  - /etc/passwd\n', /must be relative/)
})

test('parent traversal is rejected', () => {
  bad('task: "x"\ninclude:\n  - ../../.ssh/id_rsa\n', /must not contain "\.\."/)
  bad('task: "x"\ninclude:\n  - src/../../out.ts\n', /must not contain "\.\."/)
})

test('assertInsideRoot blocks escapes and allows ordinary paths', () => {
  assert.throws(() => assertInsideRoot('/repo', '../elsewhere'), /outside the repository root/)
  assert.throws(() => assertInsideRoot('/repo', '/etc/passwd'), /outside the repository root/)
  assert.equal(assertInsideRoot('/repo', 'src/a.ts'), '/repo/src/a.ts')
})

test('a repo path that merely shares a prefix with the root is still rejected', () => {
  assert.throws(() => assertInsideRoot('/repo', '../repo-secrets/a.ts'), /outside the repository root/)
})

// --- required fields ------------------------------------------------------

test('task is required and must be non-empty', () => {
  bad('include:\n  - a.ts\n', /"task" is required/)
  bad('task: "   "\ninclude:\n  - a.ts\n', /"task" is required/)
})

test('unknown keys are rejected, but underscore-prefixed notes are allowed', () => {
  bad(`${base}includes:\n  - typo.ts\n`, /unknown key\(s\).*includes/)
  const config = parseConfig(`${base}_note: "why these files"\n`)
  assert.equal(config.include.length, 1)
})

test('malformed YAML reports the file it came from', () => {
  bad('task: "x"\n  bad indent: [\n', /not valid YAML/)
})

test('a top-level list is rejected', () => {
  bad('- a\n- b\n', /must be a mapping/)
})

// --- warnings rather than errors -----------------------------------------

test('a pack with no tests is allowed but warns about it', () => {
  const config = parseConfig(base)
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0], /no "tests" listed/)
})

test('a pack with tests produces no warning', () => {
  const config = parseConfig(`${base}tests:\n  - test/a.spec.ts\n`)
  assert.deepEqual(config.warnings, [])
})

// --- redact rules ---------------------------------------------------------

test('redact rules are compiled and forced global', () => {
  const config = parseConfig(`${base}redact:\n  - pattern: "acme"\n    replace: "example"\n`)
  assert.equal(config.redact.length, 1)
  assert.ok(config.redact[0].re.global, 'a non-global redact rule would replace only the first occurrence')
})

test('an invalid redact rule is rejected at load time', () => {
  bad(`${base}redact:\n  - pattern: "(["\n    replace: "x"\n`, /invalid regex/)
  bad(`${base}redact:\n  - pattern: "a"\n`, /replace must be a string/)
  bad(`${base}redact:\n  - replace: "x"\n`, /pattern must be a non-empty string/)
})

test('an empty replacement is allowed — deleting is a valid redaction', () => {
  const config = parseConfig(`${base}redact:\n  - pattern: "acme"\n    replace: ""\n`)
  assert.equal(config.redact[0].replace, '')
})

// --- allowFindings --------------------------------------------------------

test('allowFindings entries must name a rule and a path', () => {
  bad(`${base}allowFindings:\n  - "just-a-rule-id"\n`, /must look like/)
  const config = parseConfig(`${base}allowFindings:\n  - "email:src/a.ts:12"\n`)
  assert.deepEqual(config.allowFindings, ['email:src/a.ts:12'])
})

// --- fixtures -------------------------------------------------------------

test('fixtures must map a relative path to a generator string', () => {
  bad(`${base}fixtures:\n  - not-a-map\n`, /must be a mapping/)
  bad(`${base}fixtures:\n  "/abs/path.json": shape\n`, /must be relative/)
  bad(`${base}fixtures:\n  data/a.json: ""\n`, /non-empty generator/)
})

// --- defaults -------------------------------------------------------------

test('out defaults to sparepack-out and must stay inside the repo', () => {
  assert.equal(parseConfig(base).out, 'sparepack-out')
  assert.equal(parseConfig(`${base}out: dist/pack\n`).out, 'dist/pack')
  bad(`${base}out: /tmp/anywhere\n`, /must be relative/)
})
