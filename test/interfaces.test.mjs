import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripFile, UnsupportedLanguageError } from '../src/interfaces.mjs'
import { findSurvivingBodies } from '../src/verify.mjs'

const strip = (src, path = 'src/thing.ts') => stripFile(src, path)

/**
 * The single most important assertion in this package: a secret sitting inside a function
 * body must not appear anywhere in the output. Every stripping test routes through here.
 */
function assertNotLeaked(output, ...secrets) {
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `implementation leaked into the stripped output: "${secret}"\n---\n${output}`)
  }
}

// --- the core promise -----------------------------------------------------

test('a function keeps its signature and loses its body', () => {
  const { code } = strip(`
export function chargeCard(amount: number, token: string): Promise<Receipt> {
  const gateway = new AcmeGateway("live_key_do_not_ship")
  return gateway.charge(amount, token)
}`)
  assert.match(code, /export function chargeCard\(amount: number, token: string\): Promise<Receipt>/)
  assert.match(code, /sparepack stub: not implemented/)
  assertNotLeaked(code, 'live_key_do_not_ship', 'AcmeGateway', 'gateway.charge')
})

test('JSDoc survives because it documents the contract', () => {
  const { code } = strip(`
/**
 * Charge a card. Throws on a declined transaction.
 */
export function charge(n: number): void {
  secretInternalCall(n)
}`)
  assert.match(code, /Charge a card\. Throws on a declined transaction\./)
  assertNotLeaked(code, 'secretInternalCall')
})

test('types, interfaces and enums are kept verbatim — they are the contract', () => {
  const { code } = strip(`
export interface Receipt { id: string; total: number }
export type Currency = 'USD' | 'EUR'
export enum Status { Pending, Settled }`)
  assert.match(code, /interface Receipt \{ id: string; total: number \}/)
  assert.match(code, /type Currency = 'USD' \| 'EUR'/)
  assert.match(code, /enum Status \{ Pending, Settled \}/)
})

test('imports are kept so the stub can still typecheck', () => {
  const { code } = strip(`import { Receipt } from './types'\nexport function f(): Receipt { return realWork() }`)
  assert.match(code, /import \{ Receipt \} from '\.\/types'/)
  assertNotLeaked(code, 'realWork')
})

// --- classes --------------------------------------------------------------

test('class methods are stubbed and property initialisers are dropped', () => {
  const { code } = strip(`
export class PaymentClient {
  private endpoint = "https://billing.acme-corp.internal/v2"
  public retries: number = 3
  constructor(private token: string) {
    this.validate(token)
  }
  async charge(amount: number): Promise<void> {
    await fetch(this.endpoint, { body: JSON.stringify({ amount, secret: this.token }) })
  }
  get isReady(): boolean {
    return Boolean(this.token)
  }
}`)
  assert.match(code, /class PaymentClient/)
  assert.match(code, /charge\(amount: number\): Promise<void>/)
  assert.match(code, /get isReady\(\): boolean/)
  assertNotLeaked(code, 'billing.acme-corp.internal', 'JSON.stringify', 'this.validate', 'Boolean(this.token)')
})

test('a static initialiser block is dropped with a warning', () => {
  const { code, warnings } = strip(`
export class Config {
  static { loadFromVault("prod") }
}`)
  assertNotLeaked(code, 'loadFromVault', 'prod')
  assert.ok(warnings.some((w) => /static initialiser/.test(w)))
})

// --- values are not contract ---------------------------------------------

test('an untyped top-level constant is dropped rather than published', () => {
  const { code, warnings } = strip(`export const API_BASE = "https://internal.acme-corp.lan/api"`)
  assertNotLeaked(code, 'internal.acme-corp.lan')
  assert.ok(warnings.some((w) => /API_BASE/.test(w) && /no type annotation/.test(w)))
})

test('a typed top-level constant becomes a declaration without its value', () => {
  const { code } = strip(`export const TIMEOUT_MS: number = 30_000`)
  assert.match(code, /export declare const TIMEOUT_MS: number;/)
  assertNotLeaked(code, '30_000')
})

// --- failure direction ----------------------------------------------------

test('an unrecognised top-level statement is dropped, not passed through', () => {
  const { code, warnings, dropped } = strip(`
console.log(process.env.INTERNAL_WEBHOOK)
if (isProd) { bootstrapSecrets() }
export function safe(): void { doThing() }`)
  assertNotLeaked(code, 'INTERNAL_WEBHOOK', 'bootstrapSecrets', 'isProd', 'doThing')
  assert.match(code, /export function safe\(\): void/)
  assert.ok(dropped >= 2, `expected the unrecognised statements to be counted as dropped, got ${dropped}`)
  assert.ok(warnings.length >= 2)
})

test('an unsupported language is refused rather than emitted unchanged', () => {
  assert.throws(
    () => stripFile('def charge(amount):\n    return gateway.charge(amount)\n', 'src/billing.py'),
    (err) => {
      assert.ok(err instanceof UnsupportedLanguageError)
      assert.match(err.message, /only understands/)
      assert.match(err.message, /include/)
      return true
    },
  )
})

test('every supported extension is actually handled', () => {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
    const { code } = stripFile('export function f() { secretBody() }', `src/a${ext}`)
    assertNotLeaked(code, 'secretBody')
  }
})

// --- cross-check against the independent verifier ------------------------

test('stripped output passes the verifier that looks for surviving bodies', () => {
  const source = `
import { A } from './a'
export interface Shape { n: number }
export function one(a: number): number {
  return compute(a) * SECRET_FACTOR
}
export class C {
  method(): void { doSomethingReal() }
  get v(): number { return this.internal }
}
export const T: number = 5
`
  const { code } = strip(source)
  assertNotLeaked(code, 'compute', 'SECRET_FACTOR', 'doSomethingReal', 'this.internal')
  assert.deepEqual(findSurvivingBodies(code, 'src/thing.ts'), [], 'verifier should find no surviving implementation')
})

test('the verifier catches a body the stripper would have missed', () => {
  // Guards the guard: if this ever passes, findSurvivingBodies has stopped working.
  const notStripped = `export function f(): number { return 42 }`
  const survivors = findSurvivingBodies(notStripped, 'src/x.ts')
  assert.equal(survivors.length, 1)
  assert.equal(survivors[0].name, 'f')
})

test('the verifier sees through a nested function body', () => {
  const sneaky = `
export function outer(): void {
  throw new Error('sparepack stub: not implemented')
}
const inner = () => { realLogic() }
`
  const survivors = findSurvivingBodies(sneaky, 'src/x.ts')
  assert.equal(survivors.length, 1, 'the arrow function body should be reported')
})

// --- overloads and edge shapes -------------------------------------------

test('an overload signature without a body is left alone', () => {
  const { code } = strip(`
export function parse(x: string): number
export function parse(x: number): string
export function parse(x: any): any { return realParse(x) }`)
  assert.match(code, /export function parse\(x: string\): number/)
  assertNotLeaked(code, 'realParse')
})

test('an empty file produces a header and nothing else', () => {
  const { code, kept } = strip('')
  assert.equal(kept, 0)
  assert.match(code, /Stripped by sparepack/)
})

test('the output names its source file', () => {
  const { code } = strip('export function f(): void { x() }', 'src/payment/gateway.ts')
  assert.match(code, /Source file: src\/payment\/gateway\.ts/)
})
