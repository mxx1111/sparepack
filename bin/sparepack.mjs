#!/usr/bin/env node
// sparepack CLI.

import { createInterface } from 'node:readline/promises'
import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'

import { CONFIG_NAMES, ConfigError, loadConfig } from '../src/config.mjs'
import { buildManifest, buildPack, hasBlockingFindings, renderManifest, writePack } from '../src/pack.mjs'
import { verifyPack } from '../src/verify.mjs'
import { FixtureError } from '../src/fixtures.mjs'
import { UnsupportedLanguageError } from '../src/interfaces.mjs'

const USAGE = `sparepack — turn a slice of a private repo into a shareable task pack

  sparepack init                 write a commented sparepack.yaml to get started
  sparepack pack [--yes]         build a pack, show what it contains, ask before writing
  sparepack verify <dir>         re-check a built pack from scratch

Options
  -c, --config <path>   config file (default: ./sparepack.yaml)
  -o, --out <dir>       output directory (default: from config, else ./sparepack-out)
      --yes             skip the confirmation prompt (see the warning it prints)
      --allow-findings  build even with critical/high scan findings
      --no-color        plain output

sparepack is allowlist-only: nothing is published unless you named it.
`

const TEMPLATE = `# sparepack — what to hand a stranger, and nothing more.
#
# This file is an allowlist. There is no "exclude" key on purpose: "publish everything
# except..." means a file you never thought about gets published, and that is how leaks
# happen. Here, a file you never thought about stays home.

# One line. The worker reads this before anything else.
task: "Stream large CSV imports instead of loading the whole file into memory"

# Published byte for byte. Types, constants, contracts — things you would be comfortable
# posting publicly on their own.
include:
  - src/importer/types.ts

# Signatures and types are kept; every function body is replaced with a throwing stub.
# TypeScript and JavaScript only — sparepack refuses other languages rather than
# risk shipping their implementations unchanged.
interfaces:
  - src/importer/parser.ts

# The acceptance tests. These *are* the specification: if they pass, the task is done.
# A pack without tests puts the definition of "done" in prose, and disputes follow.
tests:
  - tests/importer/*.spec.ts

# Real structure, synthetic values. Generators: empty | shape[:n] | rows:n | text:n
#   shape  reads the real JSON and rebuilds it with fake values, same keys and nesting
#   rows   keeps a delimited file's header row and generates n fake data rows
fixtures:
  data/orders.json: shape:5

# Applied to every file before scanning. Use for names the scanner cannot know about:
# your company, internal project codenames, product names under NDA.
redact:
  - pattern: "acme-corp|ACME"
    replace: "example-org"

# Extra scan rules, on top of the built-in credential and PII patterns.
# scanRules:
#   - id: internal-service
#     pattern: "\\\\b(billing|ledger)-internal\\\\b"
#     severity: high

# Findings you have looked at and decided are fine. Format: rule-id:path[:line]
# Do not add entries here to make the scanner quiet. Add them when you have read the
# specific line and concluded it is genuinely safe to publish.
# allowFindings:
#   - email:src/importer/types.ts:12

out: sparepack-out
`

function parseArgs(argv) {
  const opts = { yes: false, allowFindings: false, color: stdout.isTTY }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--allow-findings') opts.allowFindings = true
    else if (arg === '--no-color') opts.color = false
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--config' || arg === '-c') opts.config = argv[++i]
    else if (arg === '--out' || arg === '-o') opts.out = argv[++i]
    else if (arg.startsWith('-')) throw new Error(`unknown option "${arg}"`)
    else positional.push(arg)
  }
  return { opts, positional }
}

async function findConfig(explicit) {
  if (explicit) return resolve(explicit)
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(process.cwd(), name)
    try {
      await access(candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return resolve(process.cwd(), CONFIG_NAMES[0])
}

async function confirm(question) {
  if (!stdin.isTTY) {
    throw new Error(
      'confirmation required but stdin is not a terminal. ' +
        'Run this interactively, or pass --yes if you have reviewed the manifest another way.',
    )
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(question)
    return answer.trim()
  } finally {
    rl.close()
  }
}

async function cmdInit(opts) {
  const target = resolve(process.cwd(), opts.config ?? CONFIG_NAMES[0])
  try {
    await access(target)
    console.error(`${target} already exists. Delete it first if you want a fresh template.`)
    return 1
  } catch {
    // does not exist, good
  }
  await writeFile(target, TEMPLATE)
  console.log(`Wrote ${target}

Edit it, then run "sparepack pack". Two things worth knowing before you do:

  - Only what you list gets published. Patterns that match nothing are an error,
    not a silent no-op, because a typo would otherwise ship less than you meant.
  - You will be shown every file and asked to confirm before anything is written.`)
  return 0
}

async function cmdPack(opts) {
  const configPath = await findConfig(opts.config)
  const root = process.cwd()
  const config = await loadConfig(configPath)

  const built = await buildPack(root, config)
  const manifest = buildManifest(config, built)
  const outDir = resolve(root, opts.out ?? config.out)

  console.log(renderManifest(manifest, { color: opts.color }))
  console.log(`\nOutput directory: ${outDir}`)

  const blocking = hasBlockingFindings(built.findings)
  if (blocking && !opts.allowFindings) {
    console.error(
      `\nRefusing to write: the scan found credentials or personal data in what you are about to publish.\n` +
        `Fix the source, add a redact rule, or — only if you have read the specific lines and they are\n` +
        `genuinely safe — list them under allowFindings in ${configPath}.\n` +
        `\n--allow-findings overrides this. It exists for the case where the scanner is wrong, not for\n` +
        `the case where you are in a hurry.`,
    )
    return 2
  }

  if (opts.yes) {
    console.log(
      `\nWriting without confirmation (--yes). The manifest above is the only record of what ` +
        `was published; nobody looked at it.`,
    )
  } else {
    const question =
      `\nWould you be comfortable posting the file list above in public?\n` +
      `Type "publish" to write the pack, anything else to abort: `
    const answer = await confirm(question)
    if (answer !== 'publish') {
      console.log('Aborted. Nothing was written.')
      return 1
    }
  }

  const written = await writePack(outDir, manifest, built.files)
  console.log(`\nWrote ${built.files.length} file(s) to ${written}`)
  console.log(`Check it with:  sparepack verify ${outDir}`)
  return 0
}

async function cmdVerify(dir) {
  if (!dir) {
    console.error('sparepack verify needs a directory: sparepack verify ./sparepack-out')
    return 1
  }
  const target = resolve(process.cwd(), dir)
  const result = await verifyPack(target)

  console.log(`Verified ${result.scanned} file(s) in ${target}`)
  for (const note of result.notes) console.log(`  note: ${note}`)

  if (result.ok) {
    console.log('\nNo problems found. Re-scanned from disk, manifest matches, no implementation survived stripping.')
    return 0
  }
  console.error(`\n${result.problems.length} problem(s):`)
  for (const p of result.problems) console.error(`  ${p}`)
  console.error('\nDo not publish this pack until these are resolved.')
  return 2
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    console.error(`\n${USAGE}`)
    return 1
  }
  const { opts, positional } = parsed
  const command = positional[0]

  if (opts.help || !command) {
    console.log(USAGE)
    return command ? 0 : 1
  }

  switch (command) {
    case 'init':
      return cmdInit(opts)
    case 'pack':
      return cmdPack(opts)
    case 'verify':
      return cmdVerify(positional[1])
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`)
      return 1
  }
}

try {
  process.exitCode = await main()
} catch (err) {
  if (err instanceof ConfigError || err instanceof FixtureError || err instanceof UnsupportedLanguageError) {
    console.error(`\n${err.message}`)
    process.exitCode = 2
  } else {
    console.error(err)
    process.exitCode = 1
  }
}
