import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compileCustomRule, hasBlockingFindings, mask, scanText } from '../src/scan.mjs'

const ids = (findings) => findings.map((f) => f.ruleId)

/** Assert the scanner fires, and that it did not print the secret while doing so. */
function assertCaught(text, ruleId, secret) {
  const findings = scanText(text)
  assert.ok(ids(findings).includes(ruleId), `expected rule "${ruleId}", got: ${ids(findings).join(', ') || '(none)'}`)
  if (secret) {
    const dump = JSON.stringify(findings)
    assert.ok(!dump.includes(secret), `finding leaked the full secret it found:\n${dump}`)
  }
  return findings
}

function assertClean(text, message) {
  const findings = scanText(text)
  assert.deepEqual(findings, [], `${message}\nunexpected: ${ids(findings).join(', ')}`)
}

// --- the report must not become the leak ---------------------------------

test('a finding never contains the full matched secret', () => {
  const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const findings = assertCaught(`const key = "${secret}"`, 'anthropic-key', secret)
  assert.ok(findings[0].excerpt.includes('…'), 'excerpt should be masked')
  assert.ok(findings[0].excerpt.includes('chars'), 'excerpt should state the length')
})

test('mask keeps short values unreadable too', () => {
  assert.equal(mask('abc'), 'ab*')
  assert.ok(!mask('supersecretvalue').includes('secret'))
})

// --- credentials ----------------------------------------------------------

test('catches credentials across providers', () => {
  assertCaught('sk-ant-api03-' + 'x'.repeat(40), 'anthropic-key')
  assertCaught('ghp_' + 'a'.repeat(36), 'github-token')
  assertCaught('AKIAIOSFODNN7EXAMPLE', 'aws-access-key')
  assertCaught('AIza' + 'b'.repeat(35), 'google-api-key')
  assertCaught('xoxb-123456789012-abcdefghij', 'slack-token')
  assertCaught('-----BEGIN RSA PRIVATE KEY-----', 'private-key')
  assertCaught('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'jwt')
})

test('catches a connection string carrying a real password', () => {
  assertCaught('postgres://admin:hunter2real@db.internal:5432/orders', 'connection-string')
})

test('does not flag a connection string with an obvious placeholder password', () => {
  assertClean('postgres://user:password@localhost:5432/db', 'placeholder password should not fire')
  assertClean('mysql://root:${DB_PASSWORD}@localhost/app', 'env var interpolation should not fire')
  assertClean('mongodb://user:<your-password>@host/db', 'angle-bracket placeholder should not fire')
})

test('catches a hardcoded secret assignment but not one reading from the environment', () => {
  assertCaught('const apiKey = "a1b2c3d4e5f6g7h8"', 'generic-secret-assignment')
  assertClean('const apiKey = process.env.API_KEY', 'env lookup is the correct pattern, not a finding')
  assertClean('password = "changeme"', 'changeme is a placeholder')
  assertClean('const token = "<your-token-here>"', 'bracketed placeholder is not a secret')
})

// --- personal data --------------------------------------------------------

test('catches Chinese ID numbers and mobile numbers', () => {
  assertCaught('身份证 110101199003074512', 'cn-id-card')
  assertCaught('联系电话 13800138000', 'cn-mobile')
})

test('a plain long number is not an ID card', () => {
  assertClean('order 123456789012345678', 'an 18-digit order number with an invalid date must not fire')
})

test('mobile number detection respects digit boundaries', () => {
  assertClean('build 1380013800012345', 'a longer digit run should not match a mobile number')
})

// --- noise control: over-flagging is a failure ---------------------------

test('documentation placeholders do not produce findings', () => {
  assertClean('contact user@example.com for details', 'example.com is the reserved documentation domain')
  assertClean('bind to 127.0.0.1 or 0.0.0.0', 'loopback and wildcard are not internal topology')
  assertClean('see https://test.invalid/api', 'reserved TLDs are placeholders')
})

test('real emails and private addresses do produce findings', () => {
  assertCaught('escalate to ops@realcompany.io', 'email')
  assertCaught('proxy at 10.4.22.19', 'private-ip')
  assertCaught('deploy to db01.internal', 'internal-hostname')
})

test('a public IP is not flagged as internal', () => {
  assertClean('resolver 8.8.8.8', 'public DNS is not private topology')
  assertClean('version 1.2.3.4 of the spec', 'a version string must not read as an address')
})

// --- severity and blocking ------------------------------------------------

test('credentials and PII block a pack; topology only warns', () => {
  assert.equal(hasBlockingFindings(scanText('sk-ant-' + 'z'.repeat(30))), true)
  assert.equal(hasBlockingFindings(scanText('phone 13800138000')), true)
  assert.equal(hasBlockingFindings(scanText('host db01.internal')), false)
  assert.equal(hasBlockingFindings(scanText('nothing here')), false)
})

test('findings are sorted by severity, then position', () => {
  const findings = scanText(['contact a@real.io', 'key sk-ant-' + 'q'.repeat(30)].join('\n'))
  assert.equal(findings[0].severity, 'critical', 'critical must come before medium')
  assert.equal(findings[0].line, 2)
})

// --- scanning is repeatable ----------------------------------------------

test('repeated scans of the same text give identical results', () => {
  // A shared /g regex carries lastIndex between calls; this is the regression test for that.
  const text = 'a@real.io and b@real.io and c@real.io'
  const first = scanText(text)
  const second = scanText(text)
  assert.equal(first.length, 3)
  assert.deepEqual(first, second)
})

test('all occurrences on one line are reported', () => {
  const findings = scanText('10.0.0.1 10.0.0.2 10.0.0.3')
  assert.equal(findings.filter((f) => f.ruleId === 'private-ip').length, 3)
})

// --- custom rules ---------------------------------------------------------

test('a custom rule is compiled and applied', () => {
  const rule = compileCustomRule({ id: 'codename', pattern: 'PROJECT-VULCAN', severity: 'high' }, 0)
  const findings = scanText('see PROJECT-VULCAN docs', { customRules: [rule] })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, 'codename')
  assert.equal(findings[0].severity, 'high')
})

test('a custom rule without the global flag still finds every match', () => {
  const rule = compileCustomRule({ id: 'x', pattern: 'AAA', flags: 'i' }, 0)
  assert.equal(scanText('aaa AAA aAa', { customRules: [rule] }).length, 3)
})

test('an invalid custom rule fails loudly at compile time', () => {
  assert.throws(() => compileCustomRule({ id: 'bad', pattern: '([' }, 0), /invalid regex/)
  assert.throws(() => compileCustomRule({ id: 'bad', pattern: '' }, 0), /non-empty string/)
  assert.throws(() => compileCustomRule({ id: 'bad', pattern: 'x', severity: 'urgent' }, 0), /severity must be/)
})

// --- position reporting ---------------------------------------------------

test('line and column point at the finding', () => {
  const findings = scanText('line one\nline two\n  ops@real.io')
  assert.equal(findings[0].line, 3)
  assert.equal(findings[0].column, 3)
})
