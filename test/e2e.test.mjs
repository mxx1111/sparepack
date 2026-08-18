// End-to-end: build a fake private repo that is full of things which must not escape,
// run the real CLI against it, and assert on what landed on disk.
//
// The repo below is deliberately nasty — credentials in function bodies, a customer
// database, internal hostnames, a company codename, a Python file someone tried to
// list under `interfaces`. If sparepack is going to fail, it should fail here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'sparepack.mjs')

// Every one of these must be absent from the output. Referenced by name in assertions
// so a failure says which secret got out.
const SECRETS = {
  apiKey: 'sk-ant-api03-RealKeyMaterialThatMustNeverBeShipped00',
  dbPassword: 'postgres://svc:Tr0ub4dor3@db01.acme-corp.internal:5432/orders',
  customerName: '张伟',
  customerPhone: '13800138000',
  customerEmail: 'zhang.wei@acme-corp.cn',
  internalHost: 'billing-api.acme-corp.internal',
  algorithm: 'applyLoyaltyTierDiscount',
  codename: 'PROJECT-VULCAN',
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-e2e-'))
  const write = async (rel, body) => {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), body)
  }

  await write(
    'src/billing/types.ts',
    `export interface Order { id: string; totalCents: number }
export type Tier = 'basic' | 'gold'
`,
  )

  await write(
    'src/billing/gateway.ts',
    `import { Order, Tier } from './types'

const API_KEY = "${SECRETS.apiKey}"
const DB = "${SECRETS.dbPassword}"

/** Charge an order and return the receipt id. */
export async function charge(order: Order, tier: Tier): Promise<string> {
  const discounted = ${SECRETS.algorithm}(order, tier)
  const res = await fetch("https://${SECRETS.internalHost}/v2/charge", {
    headers: { authorization: API_KEY },
    body: JSON.stringify({ cents: discounted, db: DB }),
  })
  return (await res.json()).receiptId
}

function ${SECRETS.algorithm}(order: Order, tier: Tier): number {
  return tier === 'gold' ? order.totalCents * 0.82 : order.totalCents
}

export class Ledger {
  private endpoint = "https://${SECRETS.internalHost}/ledger"
  record(order: Order): void {
    void fetch(this.endpoint, { body: order.id })
  }
}
`,
  )

  await write(
    'tests/billing/charge.spec.ts',
    `import { charge } from '../../src/billing/gateway'
import { Order } from '../../src/billing/types'

test('gold tier gets 18% off', async () => {
  const order: Order = { id: 'o1', totalCents: 10_000 }
  expect(await charge(order, 'gold')).toBeDefined()
})
`,
  )

  await write(
    'data/customers.json',
    JSON.stringify(
      [
        { id: 1, name: SECRETS.customerName, phone: SECRETS.customerPhone, email: SECRETS.customerEmail },
        { id: 2, name: '李娜', phone: '13900139000', email: 'li.na@acme-corp.cn' },
      ],
      null,
      2,
    ),
  )

  await write('src/billing/legacy.py', 'def charge(order):\n    return secret_internal_logic(order)\n')

  return root
}

const CONFIG = `task: "Add proportional refunds to the billing gateway"
include:
  - src/billing/types.ts
interfaces:
  - src/billing/gateway.ts
tests:
  - tests/billing/*.spec.ts
fixtures:
  data/customers.json: shape:2
redact:
  - pattern: "${SECRETS.codename}|acme-corp"
    replace: "example-org"
out: pack
`

async function cli(root, args, { input } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: root,
      input,
      encoding: 'utf8',
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

async function readPack(root) {
  const dir = join(root, 'pack')
  const files = {}
  const walk = async (rel) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) await walk(next)
      else files[next] = await readFile(join(dir, next), 'utf8')
    }
  }
  await walk('')
  return { dir, files, all: Object.values(files).join('\n') }
}

test('a pack built from a repo full of secrets contains none of them', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), CONFIG)

  const packed = await cli(root, ['pack', '--yes', '--no-color'])
  assert.equal(packed.code, 0, `pack failed:\n${packed.stdout}\n${packed.stderr}`)

  const { dir, files, all } = await readPack(root)

  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!all.includes(secret), `pack leaked ${name}: "${secret}"`)
  }

  // Contract survived.
  assert.ok(files['src/billing/types.ts'].includes('interface Order'), 'types must be published verbatim')
  assert.match(files['src/billing/gateway.ts'], /export async function charge\(order: Order, tier: Tier\)/)
  assert.match(files['src/billing/gateway.ts'], /Charge an order and return the receipt id/)
  assert.match(files['src/billing/gateway.ts'], /sparepack stub: not implemented/)

  // The test file is the spec and is published as-is.
  assert.ok(files['tests/billing/charge.spec.ts'].includes('gold tier gets 18% off'))

  // Fixture keeps shape, loses people.
  const customers = JSON.parse(files['data/customers.json'])
  assert.equal(customers.length, 2)
  assert.deepEqual(Object.keys(customers[0]), ['id', 'name', 'phone', 'email'])

  // Redaction reached everything, including the test file.
  assert.ok(!all.includes('acme-corp'), 'redact rule should have removed the company name everywhere')

  // Orientation for the worker.
  assert.ok(files['README.md'].includes('Add proportional refunds'))
  assert.ok(files['MANIFEST.json'])

  // And the independent verifier agrees.
  const verified = await cli(root, ['verify', dir])
  assert.equal(verified.code, 0, `verify failed:\n${verified.stdout}\n${verified.stderr}`)
  assert.match(verified.stdout, /No problems found/)
})

test('the published MANIFEST.json does not become the leak', async (t) => {
  // Regression: the manifest used to carry the author's warnings and redact patterns.
  // Both describe exactly what the pack is meant to withhold — the warnings name dropped
  // internal functions, and the redact patterns are a list of the forbidden words.
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), CONFIG)

  const packed = await cli(root, ['pack', '--yes', '--no-color'])
  assert.equal(packed.code, 0)

  const manifest = JSON.parse(await readFile(join(root, 'pack', 'MANIFEST.json'), 'utf8'))
  const serialised = JSON.stringify(manifest)

  assert.ok(!serialised.includes(SECRETS.algorithm), 'manifest named a dropped internal function')
  assert.ok(!serialised.includes(SECRETS.codename), 'manifest published a redact pattern')
  assert.ok(!serialised.includes('acme-corp'), 'manifest published a redact pattern')
  assert.equal(manifest.warnings, undefined, 'author-facing warnings must not ship')
  assert.equal(manifest.findings, undefined, 'scan findings are an internal audit record')
  for (const f of manifest.files) {
    assert.equal(f.notes, undefined, `${f.path}: per-file notes must not ship`)
    assert.equal(f.redactions, undefined, `${f.path}: redaction patterns must not ship`)
  }

  // The author still gets the full picture on their terminal.
  assert.match(packed.stdout, new RegExp(SECRETS.algorithm), 'the author must be told what was dropped')

  // And what remains is enough for verify to detect tampering.
  assert.ok(manifest.files.every((f) => f.path && f.kind && typeof f.bytes === 'number'))
})

test('pack refuses to write when a listed file still contains a credential', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  // gateway.ts under `include` means verbatim publication — the key goes straight through.
  await writeFile(
    join(root, 'sparepack.yaml'),
    `task: "x"\ninclude:\n  - src/billing/gateway.ts\ntests:\n  - tests/billing/*.spec.ts\nout: pack\n`,
  )

  const result = await cli(root, ['pack', '--yes', '--no-color'])
  assert.equal(result.code, 2, 'a pack containing an API key must not be written')
  assert.match(result.stderr, /Refusing to write/)
  assert.match(result.stderr, /credentials or personal data/)

  await assert.rejects(readdir(join(root, 'pack')), /ENOENT/, 'nothing should have been written')
})

test('a rejected confirmation writes nothing', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), CONFIG)

  // Not a TTY, and no --yes: the CLI must refuse rather than assume consent.
  const result = await cli(root, ['pack', '--no-color'], { input: 'publish\n' })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /confirmation required/)
  await assert.rejects(readdir(join(root, 'pack')), /ENOENT/, 'nothing should have been written')
})

test('a pattern that matches nothing is an error, not a quiet no-op', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), `task: "x"\ninclude:\n  - src/billing/typos.ts\nout: pack\n`)

  const result = await cli(root, ['pack', '--yes'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /matched no files/)
})

test('listing a Python file under interfaces is refused, not silently copied', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), `task: "x"\ninterfaces:\n  - src/billing/legacy.py\nout: pack\n`)

  const result = await cli(root, ['pack', '--yes'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /only understands/)
  await assert.rejects(readdir(join(root, 'pack')), /ENOENT/)
})

test('verify catches a file edited after packing', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), CONFIG)
  await cli(root, ['pack', '--yes'])

  await writeFile(join(root, 'pack', 'src', 'billing', 'types.ts'), 'export interface Order { id: string }\n')
  const result = await cli(root, ['verify', join(root, 'pack')])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /changed after packing/)
})

test('verify catches an implementation smuggled into a stripped file', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sparepack.yaml'), CONFIG)
  await cli(root, ['pack', '--yes'])

  const target = join(root, 'pack', 'src', 'billing', 'gateway.ts')
  const body = await readFile(target, 'utf8')
  await writeFile(target, body.replace(/throw new Error\('sparepack stub: not implemented'\)/, 'return "real"'))

  const result = await cli(root, ['verify', join(root, 'pack')])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /still has a real body/)
})

test('verify rejects a directory that is not a pack', async (t) => {
  const root = await makeRepo()
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await cli(root, ['verify', root])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /does not look like a sparepack/)
})

test('--help succeeds, no command does not', async (t) => {
  // prepublishOnly runs `sparepack --help` as a smoke test, so its exit code has to mean
  // what it says: asking for help is a successful use of the tool, being given nothing is not.
  const root = await mkdtemp(join(tmpdir(), 'sparepack-help-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const help = await cli(root, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /sparepack — turn a slice of a private repo/)

  const bare = await cli(root, [])
  assert.equal(bare.code, 1, 'no command is a usage error')

  const bogus = await cli(root, ['frobnicate'])
  assert.equal(bogus.code, 1)
  assert.match(bogus.stderr, /unknown command/)
})

test('init writes a template and refuses to clobber an existing config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-init-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await cli(root, ['init'])
  assert.equal(first.code, 0)
  const template = await readFile(join(root, 'sparepack.yaml'), 'utf8')
  assert.match(template, /allowlist/)
  assert.match(template, /task:/)

  const second = await cli(root, ['init'])
  assert.equal(second.code, 1)
  assert.match(second.stderr, /already exists/)
})

test('the generated template is itself a valid config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-tmpl-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cli(root, ['init'])

  const { parseConfig } = await import('../src/config.mjs')
  const config = parseConfig(await readFile(join(root, 'sparepack.yaml'), 'utf8'))
  assert.equal(config.task.length > 0, true)
  assert.equal(config.interfaces.length, 1)
  assert.equal(config.redact.length, 1)
})
