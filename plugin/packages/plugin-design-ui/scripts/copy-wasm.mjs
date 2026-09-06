import { copyFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
await copyFile(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'), resolve('lib/canvaskit.wasm'))
const fontRoot = resolve(dirname(require.resolve('@open-pencil/core/package.json')), 'assets')
for (const name of await readdir(fontRoot)) {
  if (name.endsWith('.ttf')) await copyFile(resolve(fontRoot, name), resolve('lib', name))
}
