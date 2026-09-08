import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function inlineOpenPencilWorkers(): Plugin {
  return {
    name: 'inline-open-pencil-workers',
    generateBundle(_options, bundle) {
      const entry = bundle['starweave-design-embed.js']
      if (!entry || entry.type !== 'chunk') throw new Error('StarWeave Design entry chunk is missing')
      const workerNames = Object.keys(bundle).filter(name =>
        bundle[name]?.type === 'asset' && /^assets\/(?:export-)?worker-[\w-]+\.js$/u.test(name)
      )
      if (workerNames.length !== 2) {
        const outputs = Object.values(bundle).map(output => `${output.type}:${output.fileName}`).join(', ')
        throw new Error(`Expected two OpenPencil worker assets, found ${workerNames.length}; outputs: ${outputs}`)
      }
      const sources: Record<string, string> = {}
      for (const workerName of workerNames) {
        const worker = bundle[workerName]
        if (!worker || worker.type !== 'asset') throw new Error(`OpenPencil worker asset is missing: ${workerName}`)
        const workerPath = `/${workerName}`
        const pattern = new RegExp(
          `new URL\\(\\s*\\/\\* @vite-ignore \\*\\/\\s*["']${workerPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']\\s*,\\s*["']["'] \\+ import\\.meta\\.url\\s*\\)`,
          'gu'
        )
        const replaced = entry.code.replace(pattern, `__starweaveWorkerUrl(${JSON.stringify(worker.fileName)})`)
        if (replaced === entry.code) throw new Error(`OpenPencil worker reference was not found: ${workerName}`)
        entry.code = replaced
        sources[workerName] = typeof worker.source === 'string'
          ? worker.source
          : new TextDecoder().decode(worker.source)
        delete bundle[workerName]
      }
      entry.code = [
        `const __starweaveWorkerSources=${JSON.stringify(sources)};`,
        'const __starweaveWorkerUrls=new Map();',
        'function __starweaveWorkerUrl(name){let url=__starweaveWorkerUrls.get(name);if(!url){url=URL.createObjectURL(new Blob([__starweaveWorkerSources[name]],{type:"text/javascript"}));__starweaveWorkerUrls.set(name,url)}return url}',
        entry.code
      ].join('\n')
    }
  }
}

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
    vue(),
    Icons({ compiler: 'vue3' }),
    inlineOpenPencilWorkers()
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
