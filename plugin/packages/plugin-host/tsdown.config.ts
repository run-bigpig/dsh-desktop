import { defineConfig } from 'tsdown'

const shared = {
  name: '@run-bigpig/dsh-desktop-plugin-host',
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
} as const

/** Build every published subpath as a self-contained file admitted by the package whitelist. */
export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/mcp.js'] },
  { ...shared, entry: ['lib/types/openpencil.js'] },
  { ...shared, entry: ['lib/types/thinkingdata.js'] },
  { ...shared, entry: ['lib/types/vision.js'] },
  { ...shared, entry: ['lib/types/image.js'] },
  { ...shared, entry: ['lib/types/documents.js'] },
  { ...shared, entry: ['lib/types/workspace.js'] },
  { ...shared, entry: ['lib/types/git.js'] },
  { ...shared, entry: ['lib/types/chart-presentation.js'] },
  { ...shared, entry: ['lib/types/web-tools.js'] },
])
