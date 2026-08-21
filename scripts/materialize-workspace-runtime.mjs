import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, resolve, sep } from "node:path"

const [workspaceArg, deployArg] = process.argv.slice(2)
if (!workspaceArg || !deployArg) {
  throw new Error("usage: node materialize-workspace-runtime.mjs <workspace> <deployed-cli>")
}

const workspace = resolve(workspaceArg)
const deploy = resolve(deployArg)
const packageRoots = ["apps", "native", "packages", "vendor"]
const skippedDirectories = new Set([".git", "coverage", "dist", "lib", "node_modules"])
const manifests = []

function supportsCurrentPlatform(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true
  if (values.includes(`!${current}`)) return false
  const positive = values.filter((value) => typeof value === "string" && !value.startsWith("!"))
  return positive.length === 0 || positive.includes(current)
}

function walk(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || skippedDirectories.has(entry.name)) continue
    const child = join(directory, entry.name)
    const manifestPath = join(child, "package.json")
    if (existsSync(manifestPath)) manifests.push(manifestPath)
    walk(child)
  }
}

for (const root of packageRoots) walk(join(workspace, root))

const seen = new Map()
let staged = 0
for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@deepseek-ai/")) continue
  if (manifest.name === "@deepseek-ai/dsh") continue

  const parts = manifest.name.split("/")
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === ".." || part.includes(sep))) {
    throw new Error(`unsafe workspace package name: ${manifest.name}`)
  }
  const previous = seen.get(manifest.name)
  if (previous && previous !== manifestPath) {
    throw new Error(`duplicate workspace package ${manifest.name}: ${previous}, ${manifestPath}`)
  }
  seen.set(manifest.name, manifestPath)

  const source = resolve(manifestPath, "..")
  if (source !== workspace && !source.startsWith(workspace + sep)) {
    throw new Error(`workspace package escaped root: ${source}`)
  }
  const topLevelEntries = new Set()
  for (const declared of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof declared !== "string" || declared.startsWith("!")) continue
    const normalized = declared.replaceAll("\\", "/")
    const topLevel = normalized.split("/")[0]
    if (topLevel && topLevel !== "." && topLevel !== "..") topLevelEntries.add(topLevel)
  }
  const missingEntries = [...topLevelEntries].filter((entry) => !existsSync(join(source, entry)))
  if (missingEntries.length &&
      (!supportsCurrentPlatform(manifest.os, process.platform) ||
       !supportsCurrentPlatform(manifest.cpu, process.arch))) {
    continue
  }
  if (missingEntries.length) {
    throw new Error(`${manifest.name} declared missing build output: ${missingEntries.join(", ")}`)
  }

  const destination = join(deploy, "node_modules", parts[0], parts[1])
  rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  for (const entry of topLevelEntries) {
    cpSync(join(source, entry), join(destination, basename(entry)), {
      recursive: true,
      force: true,
      dereference: false,
    })
  }
  staged++
}

if (!staged) throw new Error("no DeepSeek workspace runtime packages were materialized")
process.stdout.write(`Materialized ${staged} Harness workspace packages\n`)
