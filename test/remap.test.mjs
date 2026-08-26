import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError, loadConfig } from '../src/config.mjs'
import { buildPack } from '../src/pack.mjs'

async function makePackTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'sparepack-remap-test-'))
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
  return root
}

test('remap applies multiple ordered mappings with first-match-wins', async () => {
  const root = await makePackTree({
    'sparepack.yaml': 'task: "t"\ninclude:\n  - src/api/a.ts\n  - src/lib/b.ts\n  - src/other/c.ts\nremap:\n  - from: src/api\n    to: api\n  - from: src/lib\n    to: ""\n',
    'src/api/a.ts': 'export const a = 1',
    'src/lib/b.ts': 'export const b = 2',
    'src/other/c.ts': 'export const c = 3',
  })
  const config = await loadConfig(join(root, 'sparepack.yaml'))
  const result = await buildPack(root, config)
  const paths = result.files.map(f => f.path).sort()
  assert.deepEqual(paths, ['api/a.ts', 'b.ts', 'src/other/c.ts'])
})

test('remap collision reports both source paths in error', async () => {
  const root = await makePackTree({
    'sparepack.yaml': 'task: "t"\ninclude:\n  - a/x.ts\n  - b/x.ts\nremap:\n  - from: a\n    to: out\n  - from: b\n    to: out\n',
    'a/x.ts': 'x',
    'b/x.ts': 'y',
  })
  const config = await loadConfig(join(root, 'sparepack.yaml'))
  await assert.rejects(() => buildPack(root, config), (err) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /destination path collision after remap/)
    assert.match(err.message, /a\/x\.ts/)
    assert.match(err.message, /b\/x\.ts/)
    return true
  })
})

test('remap rejects traversal in mapped destination at parse time', async () => {
  const root = await makePackTree({
    'sparepack.yaml': 'task: "t"\ninclude:\n  - src/a.ts\nremap:\n  - from: src\n    to: "../escape"\n',
    'src/a.ts': 'x',
  })
  await assert.rejects(() => loadConfig(join(root, 'sparepack.yaml')), (err) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /to must not contain "\.\."/)
    return true
  })
})

test('remap errors when no rule matches any included file', async () => {
  const root = await makePackTree({
    'sparepack.yaml': 'task: "t"\ninclude:\n  - src/a.ts\nremap:\n  - from: nonexistent\n    to: out\n',
    'src/a.ts': 'x',
  })
  const config = await loadConfig(join(root, 'sparepack.yaml'))
  await assert.rejects(() => buildPack(root, config), (err) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /"remap" rules matched no files/)
    return true
  })
})

test('stripPrefix compatibility: remap with empty to acts as stripPrefix', async () => {
  const root = await makePackTree({
    'sparepack.yaml': 'task: "t"\ninclude:\n  - packages/api/index.ts\n  - packages/api/utils.ts\nremap:\n  - from: packages/api\n    to: ""\n',
    'packages/api/index.ts': 'export {}',
    'packages/api/utils.ts': 'export {}',
  })
  const config = await loadConfig(join(root, 'sparepack.yaml'))
  const result = await buildPack(root, config)
  const paths = result.files.map(f => f.path).sort()
  assert.deepEqual(paths, ['index.ts', 'utils.ts'])
})
