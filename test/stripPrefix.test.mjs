
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseConfig } from '../src/config.mjs'
import { buildPack, writePack } from '../src/pack.mjs'

const baseYaml = `
task: "test"
include:
  - packages/api/src/a.ts
  - packages/api/src/b.ts
stripPrefix: "packages/api/"
`

test('stripPrefix applies to destination paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-strip-'))
  await mkdir(join(root, 'packages/api/src'), { recursive: true })
  await writeFile(join(root, 'packages/api/src/a.ts'), 'export const a = 1;')
  await writeFile(join(root, 'packages/api/src/b.ts'), 'export const b = 2;')
  
  const config = parseConfig(baseYaml)
  const { files } = await buildPack(root, config)
  
  const paths = files.map(f => f.destPath).sort()
  assert.deepEqual(paths, ['src/a.ts', 'src/b.ts'])
})

test('stripPrefix throws if it matches no files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-strip-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;')
  
  const yaml = `
task: "test"
include:
  - src/a.ts
stripPrefix: "packages/api/"
`
  const config = parseConfig(yaml)
  await assert.rejects(() => buildPack(root, config), /matched no files/)
})

test('stripPrefix throws on collision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-strip-'))
  await mkdir(join(root, 'packages/api/src'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'packages/api/src/a.ts'), 'export const a = 1;')
  await writeFile(join(root, 'src/a.ts'), 'export const a = 2;')
  
  const yaml = `
task: "test"
include:
  - packages/api/src/a.ts
  - src/a.ts
stripPrefix: "packages/api/"
`
  const config = parseConfig(yaml)
  await assert.rejects(() => buildPack(root, config), /collision/)
})

test('stripPrefix rejects traversal attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-strip-'))
  await mkdir(join(root, 'packages/api/src'), { recursive: true })
  await writeFile(join(root, 'packages/api/src/a.ts'), 'export const a = 1;')
  
  // The prefix doesn't match, so it falls back to original path, but let's test computeDestPath logic indirectly
  // Actually, if stripPrefix matches, it strips. If the result starts with '..' it throws.
  // Let's create a file that would result in '..' if we stripped a shorter prefix.
  // Wait, the requirement is "Stripping cannot produce a path escaping the pack root — `..` and absolute results are rejected."
  // If stripPrefix is "packages/", and file is "packages/../etc/passwd" (not possible since globs don't allow '..').
  // Let's just ensure the config parser rejects '..' in stripPrefix itself.
  const badYaml = `
task: "test"
include:
  - src/a.ts
stripPrefix: "../evil/"
`
  assert.throws(() => parseConfig(badYaml), /must not contain "\.\."/)
})

test('verify round-trip with stripPrefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-strip-'))
  const outDir = join(root, 'out')
  await mkdir(join(root, 'packages/api/src'), { recursive: true })
  await writeFile(join(root, 'packages/api/src/a.ts'), 'export const a = 1;')
  await writeFile(join(root, 'packages/api/src/b.ts'), 'export const b = 2;')
  
  const config = parseConfig(baseYaml)
  const { files } = await buildPack(root, config)
  const manifest = {
    sparepackVersion: 1,
    task: config.task,
    generated: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files: files.map(f => ({ path: f.destPath, kind: f.kind, bytes: f.bytes }))
  }
  
  await writePack(outDir, manifest, files)
  
  // Check that files were written with stripped paths
  const aContent = await readFile(join(outDir, 'src/a.ts'), 'utf8')
  assert.equal(aContent, 'export const a = 1;')
  
  // Check manifest
  const manifestContent = JSON.parse(await readFile(join(outDir, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifestContent.files[0].path, 'src/a.ts')
})
