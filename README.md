# sparepack

Turn a slice of a private repository into something you can hand a stranger.

You want help with a bug in your billing code. The bug is real, the task is small, and there
are people who would happily fix it. But the file is full of your pricing rules, your
customers, and a hardcoded key someone left in three years ago. So you don't ask, and the
bug stays.

`sparepack` produces the part that can leave: type signatures, acceptance tests, and
synthetic data with the right shape. The implementation stays on your disk.

```bash
npx sparepack init     # write a commented sparepack.yaml
npx sparepack pack     # build it, review it, confirm before anything is written
npx sparepack verify   # re-check the result from scratch
```

## What it looks like

Given this file, listed under `interfaces`:

```ts
export function calculateHealthScore(customer: Customer, tasks: Task[]): ScoreResult {
  let score = 100
  if (customer.lastContactDays > 7) { score -= 5 }
  if (customer.complaint) { score -= 15 }
  // ...another twenty lines of scoring rules
}
```

you publish this:

```ts
export interface ScoreResult { score: number; risk: Risk; reasons: string[] }

export function calculateHealthScore(customer: Customer, tasks: Task[]): ScoreResult {
  throw new Error('sparepack stub: not implemented')
}
```

The signature is a contract. The thresholds are a business decision. Only one of those needs
to leave the building.

## The three rules it is built on

**Allowlist only.** There is no `exclude` key and there will not be one. "Publish everything
except…" means a file nobody thought about gets published, which is how leaks actually
happen. Here, a file nobody thought about stays home. A pattern that matches nothing is an
error rather than a silent no-op, because a typo should not quietly ship less than you meant.

**Failures point at giving less.** Interface stripping parses your file and emits only what
it positively recognised as contract. It does not copy the file and delete the bodies. Under
the first design a parser gap produces a stub that is missing something and you notice; under
the second it publishes your source. Unsupported languages are refused outright — sparepack
handles TypeScript and JavaScript, and will not pass a `.py` file through untouched while
implying it was stripped.

**Nothing is written before you have seen it.** The whole pack is built in memory, scanned,
and printed as a manifest. Then it asks. Answer anything other than `publish` and no file is
created. The question it asks is the one that matters: *would you be comfortable posting this
file list in public?*

## What is checked

Every file is scanned after your redactions are applied — scanning before would report
findings you had already handled, and scanning after is the only way to learn the redactions
were enough.

Built-in rules cover API keys from the major providers, private key blocks, JWTs, connection
strings carrying real passwords, hardcoded secret assignments, Chinese ID and mobile numbers,
email addresses, private IP ranges, and internal hostnames.

Two things the scanner will not do. It never prints what it found in full — a report that
leaks the secret it detected is worse than no report, so findings carry a masked excerpt and
a length. And it tries hard not to cry wolf: `example.com`, `127.0.0.1`, `${DB_PASSWORD}`,
and `<your-token-here>` are placeholders, not findings. A check people learn to ignore has
stopped being a check.

Credentials and personal data block the build. Internal topology warns. Override with
`--allow-findings` if the scanner is wrong — that flag exists for that case, not for the case
where you are in a hurry.

## Configuration

```yaml
task: "Stream large CSV imports instead of loading the whole file into memory"

include:                       # published byte for byte
  - src/importer/types.ts

interfaces:                    # signatures kept, bodies replaced with a throwing stub
  - src/importer/parser.ts

tests:                         # the specification — if these pass, the task is done
  - tests/importer/*.spec.ts

fixtures:                      # real structure, synthetic values
  data/orders.json: shape:5

redact:                        # names the scanner cannot know about
  - pattern: "acme-corp|ACME"
    replace: "example-org"
```

**Fixture generators.** `shape[:n]` reads the real JSON and rebuilds it with the same keys and
nesting but fake values, capping arrays at `n` elements. `rows:n` keeps a delimited file's
header row and generates `n` fake data rows. `text:n` and `empty` need no source file.
Generation is deterministic, so rebuilding a pack twice gives byte-identical output and a
diff between two packs means something real changed.

**What counts as contract.** Exported functions and classes keep their signatures. Types,
interfaces, and enums are kept whole, exported or not, because an exported signature routinely
references an unexported type. Unexported functions and classes are dropped: an unexported
helper is implementation, and its *name alone* can give the design away — `applyLoyaltyTierDiscount`
tells you the pricing rule exists and roughly what it does, with or without a body. Top-level
values need an explicit type annotation to survive, and survive as a declaration without the
value, because a value is how a hostname or a key ends up in the output.

Anything sparepack cannot classify is dropped and reported, never passed through.

## verify

```bash
sparepack verify ./sparepack-out
```

`verify` re-derives everything from the files on disk rather than trusting the manifest,
because a check that shares assumptions with the thing it checks catches nothing. It
re-scans every file, confirms sizes match what was packed, notices files added or removed
afterwards, and re-parses every stripped file to confirm no function body survived.

Run it before you send a pack anywhere. It is the independent second opinion on `pack`.

## The manifest does not travel

The manifest you see on your terminal lists dropped internal functions by name and shows which
redact patterns fired. Both describe precisely what the pack exists to withhold, so the
`MANIFEST.json` written into the pack keeps only what `verify` needs: paths, kinds, and sizes.

### If you point the scanner at a scanner

sparepack's own test suite trips sparepack: 22 blocking findings, all of them deliberate
fixtures. That is the correct result — a scanner whose tests contain nothing that looks like
a secret is not testing anything. It is worth knowing before you wire a scan into CI over a
repository that contains security tests, since those files will light up forever.

## Limits worth knowing

Interface stripping is TypeScript and JavaScript only. Other languages are refused rather than
half-handled.

`include` publishes verbatim, so anything you list there is your judgement, not sparepack's —
the scanner is the only safety net on those files.

A pack is a set of files, not a runnable project. sparepack emits what you listed plus a
README and a manifest — it does not write a `package.json`, a tsconfig, or a test-runner
config, so a worker who clones the pack cannot run the tests until someone adds one. In
practice you write a few lines of `package.json` by hand after packing. Worth knowing before
you promise someone a pack they can `npm test` straight away.

The paths in a pack mirror the paths in your repo, with no way to remap them. Run `sparepack`
from the directory you want to be the pack's root — packing from a monorepo root gives you
`packages/api/src/...` inside the pack, which is usually not what you want.

The scanner is lexical. It finds patterns, not meaning. A business rule written in prose in a
comment, a customer name that looks like an ordinary word, an internal codename you forgot to
add to `redact` — none of those will be caught. **The manifest review is not a formality.**
It is the part of this tool that actually decides what gets published; everything else just
makes that review possible.

## Install

```bash
npm install -g sparepack
```

Node 22 or newer. Part of [spare-cycles](https://github.com/mxx1111/spare-cycles), but useful
on its own — you do not need a task board to want to ask for help without handing over your
codebase.

MIT.
