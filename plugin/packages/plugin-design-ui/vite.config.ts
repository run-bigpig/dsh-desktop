import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  plugins: [
    {
      name: 'open-pencil-published-worker-paths',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.endsWith('/worker.ts') && !source.endsWith('-worker.ts')) return null
        const javascript = resolve(dirname(importer), source.replace(/\.ts$/u, '.js'))
        return existsSync(javascript) ? javascript : null
      },
      transform(code, id) {
        if (!id.includes('/@open-pencil/core/dist/')) return null
        const fixed = code
          .replace('kiwi/fig/parse/worker.ts', 'kiwi/fig/parse/worker.js')
          .replace('export-worker.ts', 'export-worker.js')
        return fixed === code ? null : { code: fixed, map: null }
      }
    },
    vue()
  ],
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'lib',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/embed.ts',
      name: 'StarWeaveDesignEmbed',
      formats: ['es'],
      fileName: () => 'starweave-design-embed.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: asset => asset.name?.endsWith('.css')
          ? 'starweave-design-embed.css'
          : '[name][extname]'
      }
    }
  }
})
