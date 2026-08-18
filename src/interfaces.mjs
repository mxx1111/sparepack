// Interface stripping: keep the contract, drop the implementation.
//
// The safety property that matters here is the direction of failure. Two ways to build this:
//
//   (a) copy the file, then delete the function bodies
//   (b) parse the file, then emit only what was positively identified as contract
//
// Under (a) a parser gap leaks business logic. Under (b) a parser gap produces a stub that
// is missing something, which the author notices in the manifest. This module does (b):
// nothing reaches the output unless a specific branch below decided to put it there.
//
// The `default: skip and warn` at the bottom of the dispatch is the whole design.

import { extname } from 'node:path'
import ts from 'typescript'

const SCRIPT_KINDS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.js', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
])

export const SUPPORTED_EXTENSIONS = [...SCRIPT_KINDS.keys()]

const STUB_BODY = `{
  throw new Error('sparepack stub: not implemented')
}`

export class UnsupportedLanguageError extends Error {}

/**
 * Source text of a node including its leading JSDoc, stopping before `stopAt`.
 * Comments are contract documentation and worth keeping; whatever sits after
 * `stopAt` is implementation and never enters the output.
 */
function signatureText(source, node, stopAt) {
  const commentRanges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []
  const docComments = commentRanges.filter((r) => source.slice(r.pos, r.pos + 3) === '/**')
  const start = docComments.length ? docComments[0].pos : node.getStart()
  const end = stopAt ?? node.getEnd()
  return source.slice(start, end).trimEnd()
}

function modifierText(node) {
  const mods = ts.getModifiers?.(node) ?? []
  return mods.map((m) => m.getText()).join(' ')
}

/**
 * Only exported declarations are contract.
 *
 * An unexported top-level function is an implementation detail, and its *name* alone can
 * give the whole thing away — `applyLoyaltyTierDiscount` tells a reader the pricing rule
 * exists and roughly what it does, even with the body gone. Types are the exception: they
 * carry no logic, and an exported signature routinely references an unexported one, so
 * dropping them would produce a stub that cannot typecheck.
 */
function isExported(node) {
  const mods = ts.getModifiers?.(node) ?? []
  return mods.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DeclareKeyword,
  )
}

/** A function-like declaration becomes its signature plus a throwing body. */
function stripFunctionLike(source, node) {
  if (!node.body) return `${signatureText(source, node)}` // overload signature, already bodyless
  return `${signatureText(source, node, node.body.getStart())} ${STUB_BODY}`
}

function stripClassMember(source, member, warnings, className) {
  if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) {
    return stripFunctionLike(source, member)
  }
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return stripFunctionLike(source, member)
  }
  if (ts.isPropertyDeclaration(member)) {
    // Keep the declared shape, drop the initialiser — an initialiser is a value,
    // and values are exactly the thing that turns out to be a hostname or a key.
    const stop = member.initializer ? member.initializer.getStart() : member.getEnd()
    const text = signatureText(source, member, stop).replace(/=\s*$/, '').trimEnd()
    return member.initializer ? `${text}${member.type ? '' : ': unknown'};` : text
  }
  if (ts.isIndexSignatureDeclaration(member) || ts.isPropertySignature(member) || ts.isMethodSignature(member)) {
    return signatureText(source, member)
  }
  if (ts.isClassStaticBlockDeclaration(member)) {
    warnings.push(`${className}: static initialiser block dropped (it is implementation, not contract)`)
    return null
  }
  warnings.push(`${className}: member of kind ${ts.SyntaxKind[member.kind]} was not recognised and has been dropped`)
  return null
}

function stripClass(source, node, warnings) {
  const name = node.name?.getText() ?? '(anonymous class)'
  const header = signatureText(source, node, node.members.length ? node.members[0].getFullStart() : node.getEnd())
    .replace(/\{[\s\S]*$/, '{')
    .trimEnd()
  const body = node.members
    .map((m) => stripClassMember(source, m, warnings, name))
    .filter(Boolean)
    .map((t) => t.split('\n').map((l) => (l.trim() ? `  ${l.replace(/^\s{0,2}/, '')}` : l)).join('\n'))
    .join('\n\n')
  return `${header.endsWith('{') ? header : `${header} {`}\n${body}\n}`
}

/**
 * A top-level variable is only contract if its type is written down. `const TIMEOUT = 30_000`
 * is a value; `declare const TIMEOUT: number` is a contract. Emitting the value would ship
 * configuration, so an untyped one is dropped with a warning telling the author to annotate it.
 */
function stripVariableStatement(source, node, warnings) {
  const kept = []
  for (const decl of node.declarationList.declarations) {
    const name = decl.name.getText()
    if (!decl.type) {
      warnings.push(
        `"${name}" has no type annotation, so its value would have to be published to say anything about it — dropped. ` +
          `Add an explicit type if the worker needs to know it exists.`,
      )
      continue
    }
    kept.push(`${name}: ${decl.type.getText()}`)
  }
  if (!kept.length) return null
  const mods = modifierText(node)
  const prefix = mods.includes('export') ? 'export declare' : 'declare'
  const keyword = node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let'
  return kept.map((k) => `${prefix} ${keyword} ${k};`).join('\n')
}

/**
 * Strip one file down to its contract.
 * @returns {{code: string, warnings: string[], kept: number, dropped: number}}
 */
export function stripFile(source, filePath) {
  const ext = extname(filePath).toLowerCase()
  const scriptKind = SCRIPT_KINDS.get(ext)
  if (!scriptKind) {
    throw new UnsupportedLanguageError(
      `cannot strip "${filePath}": sparepack only understands ${SUPPORTED_EXTENSIONS.join(', ')}. ` +
        `Emitting it unchanged would publish the implementation, so it is refused instead. ` +
        `Move it to "include" if you genuinely mean to expose it verbatim.`,
    )
  }

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind)
  const warnings = []
  const chunks = []
  let dropped = 0

  const drop = (node, why) => {
    dropped++
    warnings.push(why ?? `statement of kind ${ts.SyntaxKind[node.kind]} dropped`)
  }

  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      chunks.push(node.getText())
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      // Pure contract. Kept verbatim, comments and all.
      chunks.push(signatureText(source, node))
    } else if (ts.isFunctionDeclaration(node)) {
      if (isExported(node)) chunks.push(stripFunctionLike(source, node))
      else
        drop(
          node,
          `internal function "${node.name?.getText() ?? '(anonymous)'}" dropped: not exported, so it is ` +
            `implementation rather than contract — its name alone would describe the logic`,
        )
    } else if (ts.isClassDeclaration(node)) {
      if (isExported(node)) chunks.push(stripClass(source, node, warnings))
      else
        drop(
          node,
          `internal class "${node.name?.getText() ?? '(anonymous)'}" dropped: not exported`,
        )
    } else if (ts.isVariableStatement(node)) {
      if (!isExported(node)) {
        drop(node, `internal variable declaration dropped: not exported`)
        continue
      }
      const text = stripVariableStatement(source, node, warnings)
      if (text) chunks.push(text)
      else dropped++
    } else if (ts.isExportDeclaration(node)) {
      chunks.push(node.getText())
    } else if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      drop(node, `namespace "${node.name.getText()}" dropped: nested declarations are not stripped yet`)
    } else if (node.kind === ts.SyntaxKind.EmptyStatement) {
      // nothing
    } else {
      drop(
        node,
        `top-level ${ts.SyntaxKind[node.kind]} dropped — sparepack only emits what it can positively ` +
          `identify as contract, and this is not on that list`,
      )
    }
  }

  const header = `// Stripped by sparepack: signatures and types only, implementations removed.\n` +
    `// Source file: ${filePath}\n`

  return {
    code: `${header}\n${chunks.join('\n\n')}\n`,
    warnings,
    kept: chunks.length,
    dropped,
  }
}
