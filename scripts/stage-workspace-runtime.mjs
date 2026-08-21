import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

const [checkoutArg, targetArg] = process.argv.slice(2)
if (!checkoutArg || !targetArg) {
  throw new Error("usage: node stage-workspace-runtime.mjs <checkout> <staged-runtime>")
}

const checkout = resolve(checkoutArg)
const target = resolve(targetArg)
const packageRoots = ["apps", "native", "packages", "vendor"]
const skippedDirectories = new Set([".git", "coverage", "dist", "lib", "node_modules"])
const manifests = []

function copyFile(source, destination) {
  if (!existsSync(source)) throw new Error(`required runtime file is missing: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { force: true })
}

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

mkdirSync(target, { recursive: true })
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  copyFile(join(checkout, file), join(target, file))
}
if (existsSync(join(checkout, "patches"))) {
  cpSync(join(checkout, "patches"), join(target, "patches"), { recursive: true, force: true })
}

for (const root of packageRoots) walk(join(checkout, root))

const seen = new Map()
let staged = 0
for (const manifestPath of manifests) {
  const manifestText = readFileSync(manifestPath, "utf8")
  const manifest = JSON.parse(manifestText)
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@deepseek-ai/")) continue

  const previous = seen.get(manifest.name)
  if (previous && previous !== manifestPath) {
    throw new Error(`duplicate workspace package ${manifest.name}: ${previous}, ${manifestPath}`)
  }
  seen.set(manifest.name, manifestPath)

  const source = resolve(manifestPath, "..")
  const relativeSource = relative(checkout, source)
  if (!relativeSource || relativeSource === ".." || relativeSource.startsWith(`..${sep}`)) {
    throw new Error(`workspace package escaped checkout: ${source}`)
  }

  const topLevelEntries = new Set()
  for (const declared of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof declared !== "string" || declared.startsWith("!")) continue
    const normalized = declared.replaceAll("\\", "/")
    const topLevel = normalized.split("/")[0]
    if (topLevel && topLevel !== "." && topLevel !== "..") topLevelEntries.add(topLevel)
  }
  const missingEntries = [...topLevelEntries].filter((entry) => !existsSync(join(source, entry)))
  const unsupported = !supportsCurrentPlatform(manifest.os, process.platform) ||
    !supportsCurrentPlatform(manifest.cpu, process.arch)
  if (missingEntries.length && !unsupported) {
    throw new Error(`${manifest.name} declared missing build output: ${missingEntries.join(", ")}`)
  }

  const destination = join(target, relativeSource)
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, "package.json"), manifestText)
  for (const entry of topLevelEntries) {
    if (!existsSync(join(source, entry))) continue
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true,
      force: true,
      dereference: false,
    })
  }
  staged++
}

if (!staged) throw new Error("no DeepSeek workspace runtime packages were staged")
if (!existsSync(join(target, "apps", "cli", "lib", "bin.js"))) {
  throw new Error("staged workspace is missing the built CLI entry")
}
process.stdout.write(`Staged compiled files for ${staged} Harness workspace packages\n`)
