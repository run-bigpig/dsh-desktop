import { clientBundle } from '../../client/tsdown.client.ts'
import MagicString from 'magic-string'
import { resolve } from 'node:path'

const build = clientBundle('@run-bigpig/dsh-desktop-plugin-client', ['lib/types/index.js'])
const yogaAdapter = resolve(import.meta.dirname, 'src/client/openpencil/yoga.ts')
const unifontAdapter = resolve(import.meta.dirname, 'src/client/openpencil/unifont.ts')

export default (inlineConfig: Parameters<typeof build>[0]) => build(inlineConfig).map(config => {
  if (config.name !== '@run-bigpig/dsh-desktop-plugin-client/client') return config
  return {
    ...config,
    define: {
      ...config.define,
      'import.meta.url': 'globalThis.location.href',
    },
    outputOptions: {
      ...config.outputOptions,
      codeSplitting: false,
    },
    plugins: [
      {
        name: 'starweave-openpencil-browser-adapters',
        resolveId(source: string, importer: string | undefined) {
          if (source === 'yoga-layout') return yogaAdapter
          if (source === 'unifont') return unifontAdapter
          if (source === 'fflate') return this.resolve('fflate/browser', importer, { skipSelf: true })
          return null
        },
        transform(code: string, id: string) {
          const normalized = id.replaceAll('\\', '/')
          if (normalized.includes('/@open-pencil/core/dist/io/formats/fig/export.js')) {
            const workerCheck = 'return typeof Worker !== "undefined" && IS_BROWSER;'
            if (!code.includes(workerCheck)) throw new Error('unexpected OpenPencil FIG export worker shape')
            return replaceWithSourceMap(code, workerCheck, 'return false;')
          }
          if (normalized.includes('/@open-pencil/core/dist/io/formats/fig/read.js')) {
            const workerCheck = 'if (typeof Worker !== "undefined" && IS_BROWSER) {'
            if (!code.includes(workerCheck)) throw new Error('unexpected OpenPencil FIG import worker shape')
            return replaceWithSourceMap(code, workerCheck, 'if (false) {')
          }
          return null
        },
      },
      ...(config.plugins ?? []),
    ],
  }
})

function replaceWithSourceMap(code: string, search: string, replacement: string) {
  const start = code.indexOf(search)
  const output = new MagicString(code)
  output.overwrite(start, start + search.length, replacement)
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, includeContent: true }),
  }
}
