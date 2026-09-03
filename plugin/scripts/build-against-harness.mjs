import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`missing ${name} <path>`)
  return resolve(process.argv[index + 1])
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)))
  })
}

async function collectWorkspaceVersions(root, versions) {
  const ignored = new Set(['.git', '.pnpm', 'dist', 'lib', 'node_modules'])
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const manifestPath = resolve(root, 'package.json')
  if (await exists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !ignored.has(entry.name)) {
      await collectWorkspaceVersions(resolve(root, entry.name), versions)
    }
  }
}

function publishRange(value, dependency, versions) {
  if (typeof value !== 'string' || !value.startsWith('workspace:')) return value
  const version = versions.get(dependency)
  if (!version) throw new Error(`unable to resolve workspace version for ${dependency}`)
  const range = value.slice('workspace:'.length)
  if (range === '^') return `^${version}`
  if (range === '~') return `~${version}`
  if (range === '*') return version
  return range
}

async function copySelectedTree(source, target, suffixes) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name)
    const targetPath = resolve(target, entry.name)
    if (entry.isDirectory()) {
      await copySelectedTree(sourcePath, targetPath, suffixes)
    } else if (entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix))) {
      await cp(sourcePath, targetPath)
    }
  }
}

async function stagePackage(source, target, selection, versions) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const file of selection.files) {
    await cp(resolve(source, file), resolve(target, file))
  }
  for (const tree of selection.trees ?? []) {
    await copySelectedTree(resolve(source, tree.path), resolve(target, tree.path), tree.suffixes)
  }
  const manifestPath = resolve(target, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!manifest[section]) continue
    for (const [dependency, value] of Object.entries(manifest[section])) {
      manifest[section][dependency] = publishRange(value, dependency, versions)
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const project = resolve(import.meta.dirname, '..')
const harness = option('--harness')
const output = option('--out')
const store = resolve(dirname(harness), 'pnpm-store')
if (!await exists(resolve(harness, 'packages/client/tsdown.client.ts'))) {
  throw new Error(`${harness} is not a DeepSeek Harness source checkout`)
}
const seed = JSON.parse(await readFile(resolve(harness, 'package.json'), 'utf8'))
process.stdout.write(`building Desktop integration against Harness ${seed.version}\n`)
const overlay = resolve(harness, 'packages/desktop')
await rm(overlay, { recursive: true, force: true })
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
await mkdir(overlay, { recursive: true })
for (const name of ['plugin-host', 'plugin-client', 'plugin-bundle']) {
  await cp(resolve(project, 'packages', name), resolve(overlay, name), { recursive: true })
}
await run(pnpm, [
  'install', '--frozen-lockfile=false', '--ignore-scripts',
  '--filter', '@run-bigpig/dsh-desktop-plugin-host...',
  '--filter', '@run-bigpig/dsh-desktop-plugin-client...',
  '--filter', '@run-bigpig/dsh-desktop-plugin...',
  '--store-dir', store, '--prefer-offline',
], harness)
const harnessRequire = createRequire(resolve(harness, 'package.json'))
const tsc = harnessRequire.resolve('typescript/bin/tsc')
const tsdown = harnessRequire.resolve('tsdown/run')
await run(process.execPath, [tsc, '-b', 'packages/desktop/plugin-host'], harness)
const generatorURL = pathToFileURL(resolve(harness, 'packages/typert/generator/lib/types/workspace.js')).href
const { WorkspaceTypertGenerator } = await import(generatorURL)
const hostAggregatePath = resolve(harness, 'tsconfig.host.json')
const hostAggregate = await readFile(hostAggregatePath, 'utf8')
const hostMarker = '    { "path": "./apps/cli" }'
if (!hostAggregate.includes(hostMarker)) throw new Error('unexpected Harness host aggregate shape')
const hostManifestPath = resolve(overlay, 'plugin-host/package.json')
const hostManifestText = await readFile(hostManifestPath, 'utf8')
const typertHostManifest = JSON.parse(hostManifestText)
delete typertHostManifest.exports?.['./web-tools']
await writeFile(hostAggregatePath, hostAggregate.replace(
  hostMarker,
  '    { "path": "./packages/desktop/plugin-host" },\n' + hostMarker,
))
await writeFile(hostManifestPath, `${JSON.stringify(typertHostManifest, null, 2)}\n`)
let artifacts
try {
  artifacts = new WorkspaceTypertGenerator(harness).generate(
    ['@run-bigpig/dsh-desktop-plugin-host'],
    ['host'],
  )
} finally {
  await writeFile(hostAggregatePath, hostAggregate)
  await writeFile(hostManifestPath, hostManifestText)
}
if (artifacts.length !== 1) throw new Error(`expected one Desktop Plugin Host Typert artifact, got ${artifacts.length}`)
const hostDir = resolve(overlay, 'plugin-host')
for (const artifact of artifacts) {
  await writeFile(resolve(hostDir, `lib/typert.${artifact.face}.js`), artifact.js)
  await writeFile(resolve(hostDir, `lib/typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    await writeFile(resolve(hostDir, 'lib/typert.remote-client.js'), artifact.remote.js)
    await writeFile(resolve(hostDir, 'lib/typert.remote-client.d.ts'), artifact.remote.dts)
    await writeFile(resolve(hostDir, 'lib/typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
}
await run(process.execPath, [tsdown, '--config', 'packages/desktop/plugin-host/tsdown.config.ts'], harness)
await run(process.execPath, [tsc, '-b', 'packages/desktop/plugin-client'], harness)
await run(process.execPath, [
  tsdown, '--config', 'packages/desktop/plugin-client/tsdown.config.ts', '--env.DSH_BUILD_FACE', 'client',
], harness)
const clientSourceMap = JSON.parse(await readFile(resolve(overlay, 'plugin-client/lib/client.js.map'), 'utf8'))
const clientSources = Array.isArray(clientSourceMap.sources) ? clientSourceMap.sources : []
for (const source of ['@rc-component/image/es/Image.js', '@rc-component/image/es/PreviewGroup.js']) {
  if (!clientSources.some(candidate => typeof candidate === 'string' && candidate.replaceAll('\\', '/').endsWith(source))) {
    throw new Error(`Desktop image preview did not bundle the ESM source ${source}`)
  }
}
const versions = new Map()
for (const root of ['vendor', 'packages', 'apps', 'native']) {
  await collectWorkspaceVersions(resolve(harness, root), versions)
}
await stagePackage(hostDir, resolve(output, 'plugin-host'), {
  files: [
    'package.json', 'lib/index.js', 'lib/mcp.js', 'lib/openpencil.js', 'lib/thinkingdata.js', 'lib/vision.js', 'lib/image.js', 'lib/documents.js', 'lib/workspace.js', 'lib/git.js', 'lib/chart-presentation.js', 'lib/web-tools.js', 'lib/typert.host.js', 'lib/typert.host.d.ts',
    'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts',
  ],
  trees: [
    { path: 'lib/types', suffixes: ['.js', '.d.ts'] },
    { path: 'skills', suffixes: ['.md', '.yaml'] },
  ],
}, versions)
await stagePackage(resolve(overlay, 'plugin-client'), resolve(output, 'plugin-client'), {
  files: ['package.json', 'lib/index.js', 'lib/client.js', 'lib/client.js.map'],
  trees: [{ path: 'lib/types', suffixes: ['.d.ts'] }],
}, versions)
const stagedClientEntry = await readFile(resolve(output, 'plugin-client/lib/client.js'), 'utf8')
const relativeClientRequires = new Set(
  [...stagedClientEntry.matchAll(/require\((["'])\.\/([^"']+)\1\)/gu)].map(match => match[2]),
)
if (relativeClientRequires.size > 0) {
  throw new Error(
    `Desktop Plugin Client must be a single Harness module-table factory; found relative runtime imports: ${[...relativeClientRequires].join(', ')}`,
  )
}
if (/require\((["'])(?:node:)?url\1\)/u.test(stagedClientEntry)) {
  throw new Error('Desktop Plugin Client contains a Node URL require generated from a browser import.meta.url')
}
const platformArtifactURL = pathToFileURL(resolve(harness, 'packages/client/web/lib/types/platform.js')).href
const { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } = await import(platformArtifactURL)
const stagedClientManifest = JSON.parse(await readFile(resolve(output, 'plugin-client/package.json'), 'utf8'))
const allowedClientRequires = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...(stagedClientManifest.dsh?.client?.external ?? []),
])
const runtimeRegionEnd = stagedClientEntry.indexOf('\n\t\t//#endregion')
const firstModuleRegion = stagedClientEntry.indexOf('\n\t\t//#region ', runtimeRegionEnd + 1)
if (runtimeRegionEnd < 0 || firstModuleRegion < 0) {
  throw new Error('unexpected Desktop Plugin Client closure bundle shape')
}
const clientImportPreamble = stagedClientEntry.slice(runtimeRegionEnd, firstModuleRegion)
const topLevelClientRequires = new Set(
  [...clientImportPreamble.matchAll(/require\((["'])([^"']+)\1\)/gu)].map(match => match[2]),
)
const unavailableClientRequires = [...topLevelClientRequires].filter(specifier => !allowedClientRequires.has(specifier))
if (unavailableClientRequires.length > 0) {
  throw new Error(
    `Desktop Plugin Client has top-level imports unavailable from the Harness module table: ${unavailableClientRequires.join(', ')}`,
  )
}
await stagePackage(resolve(overlay, 'plugin-bundle'), resolve(output, 'plugin-bundle'), {
  files: ['package.json', 'cordis.patch.yml', 'THIRD_PARTY_NOTICES.md'],
  trees: [{ path: 'LICENSES', suffixes: ['.txt'] }],
}, versions)
const hostManifest = JSON.parse(await readFile(resolve(output, 'plugin-host/package.json'), 'utf8'))
for (const dependency of ['undici', 'ws']) {
  if (typeof hostManifest.dependencies?.[dependency] !== 'string') {
    throw new Error(`staged Desktop Plugin Host is missing ${dependency}`)
  }
}
if (!await exists(resolve(output, 'plugin-host/lib/web-tools.js'))) {
  throw new Error('staged Desktop Plugin Host is missing the web-tools entry')
}
if (await exists(resolve(output, 'web-tools'))) {
  throw new Error('standalone dsh-web-tools package must not be staged')
}
process.stdout.write(`Desktop integration package directories written to ${basename(output)}\n`)
