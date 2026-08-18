// Independent verification of a built pack.
//
// This deliberately re-derives everything from the files on disk instead of trusting the
// manifest. The point is to catch a bug in pack.mjs, and a check that shares its assumptions
// with the thing it checks catches nothing. Notably it re-parses every stripped file to
// confirm no function body survived — if interface stripping ever regresses, this is what
// notices before the pack reaches a stranger.

import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { glob } from 'node:fs/promises'
import ts from 'typescript'

import { hasBlockingFindings, scanText } from './scan.mjs'
import { STRIPPED } from './pack.mjs'

const STUB_MARKER = 'sparepack stub: not implemented'

/** A body counts as a stub when it does nothing but throw the marker. */
function isStubBody(body, source) {
  if (!body || !ts.isBlock(body)) return false
  const statements = body.statements
  if (statements.length !== 1) return false
  const only = statements[0]
  if (!ts.isThrowStatement(only)) return false
  return source.slice(only.getStart(), only.getEnd()).includes(STUB_MARKER)
}

/** Walk a stripped file looking for any function body that still contains logic. */
export function findSurvivingBodies(source, path) {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const survivors = []

  const visit = (node) => {
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)

    if (isFunctionLike && node.body && !isStubBody(node.body, source)) {
      const name = node.name?.getText?.() ?? '(anonymous)'
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
      survivors.push({ name, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return survivors
}

/**
 * Verify a pack directory.
 * @returns {{ok: boolean, problems: string[], notes: string[], scanned: number}}
 */
export async function verifyPack(dir) {
  const problems = []
  const notes = []

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8'))
  } catch (err) {
    return {
      ok: false,
      scanned: 0,
      notes,
      problems: [
        err.code === 'ENOENT'
          ? `no MANIFEST.json in ${dir} — this does not look like a sparepack`
          : `MANIFEST.json is unreadable: ${err.message}`,
      ],
    }
  }

  const declared = new Map((manifest.files ?? []).map((f) => [f.path, f]))
  let scanned = 0

  // Every file actually present, not just the ones the manifest admits to.
  const present = []
  for await (const entry of glob('**/*', { cwd: dir, withFileTypes: true })) {
    if (!entry.isFile()) continue
    present.push(relative(dir, join(entry.parentPath ?? entry.path, entry.name)))
  }

  for (const path of present.sort()) {
    if (path === 'MANIFEST.json' || path === 'README.md') continue

    const entry = declared.get(path)
    if (!entry) {
      problems.push(`"${path}" is in the pack but not in MANIFEST.json — it was added after packing`)
    }

    const body = await readFile(join(dir, path), 'utf8')
    const bytes = Buffer.byteLength(body)
    if (entry && entry.bytes !== bytes) {
      problems.push(`"${path}" is ${bytes} bytes but MANIFEST.json says ${entry.bytes} — it changed after packing`)
    }

    const findings = scanText(body, { path })
    scanned++
    if (hasBlockingFindings(findings)) {
      for (const f of findings.filter((x) => ['critical', 'high'].includes(x.severity))) {
        problems.push(`${f.severity} finding in ${f.path}:${f.line} — ${f.label} ${f.excerpt}`)
      }
    } else if (findings.length) {
      notes.push(`${findings.length} low-severity finding(s) in ${path}`)
    }

    if (entry?.kind === STRIPPED) {
      const survivors = findSurvivingBodies(body, path)
      for (const s of survivors) {
        problems.push(
          `"${path}" is marked as stripped but ${s.name} at line ${s.line} still has a real body — ` +
            `implementation may have leaked`,
        )
      }
    }
  }

  for (const path of declared.keys()) {
    if (!present.includes(path)) problems.push(`MANIFEST.json lists "${path}" but it is missing from the pack`)
  }

  if (!(manifest.files ?? []).some((f) => f.role === 'acceptance-test')) {
    notes.push('this pack ships no acceptance tests, so "done" is defined in prose only')
  }

  try {
    await stat(join(dir, 'README.md'))
  } catch {
    notes.push('no README.md — the worker gets no orientation')
  }

  return { ok: problems.length === 0, problems, notes, scanned }
}
