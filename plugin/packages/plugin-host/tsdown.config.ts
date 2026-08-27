import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@run-bigpig/dsh-desktop-plugin-host',
  entry: ['lib/types/index.js', 'lib/types/mcp.js', 'lib/types/vision.js', 'lib/types/image.js', 'lib/types/documents.js', 'lib/types/workspace.js', 'lib/types/git.js', 'lib/types/ta-presentation.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
