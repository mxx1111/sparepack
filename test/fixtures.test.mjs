import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FixtureError, generateFixture } from '../src/fixtures.mjs'
import { scanText } from '../src/scan.mjs'

test('shape keeps structure and keys but replaces every value', () => {
  const real = JSON.stringify({
    orderId: 'ORD-99182',
    total: 1493.22,
    paid: true,
    customer: { name: '张伟', email: 'zhang.wei@realcompany.cn', phone: '13800138000' },
    items: [{ sku: 'SKU-001', qty: 3 }],
  })
  const out = generateFixture('shape', real, 'data/orders.json')
  const parsed = JSON.parse(out)

  assert.deepEqual(Object.keys(parsed), ['orderId', 'total', 'paid', 'customer', 'items'])
  assert.deepEqual(Object.keys(parsed.customer), ['name', 'email', 'phone'])
  assert.equal(typeof parsed.total, 'number')
  assert.equal(typeof parsed.paid, 'boolean')
  assert.ok(Array.isArray(parsed.items))

  for (const secret of ['ORD-99182', '1493.22', '张伟', 'zhang.wei@realcompany.cn', '13800138000', 'SKU-001']) {
    assert.ok(!out.includes(secret), `fixture leaked real data: ${secret}`)
  }
})

test('a generated fixture does not itself trip the scanner', () => {
  const real = JSON.stringify({ email: 'a@realcompany.cn', phone: '13800138000', host: '10.1.2.3' })
  const out = generateFixture('shape', real, 'data/contacts.json')
  assert.deepEqual(scanText(out, { path: 'data/contacts.json' }), [], 'synthetic values must be scanner-clean')
})

test('key names steer the synthetic value so the fixture still reads sensibly', () => {
  const out = JSON.parse(generateFixture('shape', JSON.stringify({ email: 'x@y.z', createdAt: 'x' }), 'a.json'))
  assert.match(out.email, /@example\.com$/)
  assert.match(out.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('a secret-looking key gets an explicitly redacted value', () => {
  const out = JSON.parse(generateFixture('shape', JSON.stringify({ apiToken: 'sk-ant-real' }), 'a.json'))
  assert.equal(out.apiToken, 'REDACTED-BY-SPAREPACK')
})

test('shape:n caps how many array elements are emitted', () => {
  const real = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) })
  assert.equal(JSON.parse(generateFixture('shape:4', real, 'a.json')).rows.length, 4)
  assert.equal(JSON.parse(generateFixture('shape', real, 'a.json')).rows.length, 3)
})

test('generation is deterministic', () => {
  const real = JSON.stringify({ a: 'x', b: [{ c: 1 }] })
  assert.equal(generateFixture('shape', real, 'a.json'), generateFixture('shape', real, 'a.json'))
})

test('rows keeps the header and replaces the data', () => {
  const csv = '编号,姓名,手机号\n007,张伟,13800138000\n008,李娜,13900139000\n'
  const out = generateFixture('rows:3', csv, 'data/people.csv')
  const lines = out.trim().split('\n')

  assert.equal(lines[0], '编号,姓名,手机号', 'the header is a column contract and must survive')
  assert.equal(lines.length, 4)
  for (const secret of ['张伟', '13800138000', '李娜']) {
    assert.ok(!out.includes(secret), `csv fixture leaked: ${secret}`)
  }
})

test('rows respects the tsv delimiter', () => {
  const out = generateFixture('rows:2', 'a\tb\n1\t2\n', 'data/x.tsv')
  assert.ok(out.split('\n')[1].includes('\t'))
})

test('empty and text need no source file', () => {
  assert.equal(generateFixture('empty', null, 'a.bin'), '')
  assert.equal(generateFixture('text:2', null, 'a.txt').trim().split('\n').length, 2)
})

test('shape and rows fail loudly when the real file is missing', () => {
  assert.throws(() => generateFixture('shape', null, 'data/gone.json'), FixtureError)
  assert.throws(() => generateFixture('rows:5', null, 'data/gone.csv'), /does not exist/)
})

test('invalid JSON under shape is an error, not a silent pass-through', () => {
  assert.throws(() => generateFixture('shape', '{not json', 'a.json'), /needs valid JSON/)
})

test('an unrecognised generator is rejected', () => {
  assert.throws(() => generateFixture('faker:order[20]', '{}', 'a.json'), /unrecognised generator/)
  assert.throws(() => generateFixture('rows', 'a,b\n', 'a.csv'), /needs a count/)
})
