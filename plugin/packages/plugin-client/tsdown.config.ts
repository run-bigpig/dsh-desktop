import { clientBundle } from '../../client/tsdown.client.ts'
import { resolve } from 'node:path'

const build = clientBundle('@run-bigpig/dsh-desktop-plugin-client', ['lib/types/index.js'])
const yogaAdapter = resolve(import.meta.dirname, 'src/client/openpencil/yoga.ts')
const unifontAdapter = resolve(import.meta.dirname, 'src/client/openpencil/unifont.ts')

export default (inlineConfig: Parameters<typeof build>[0]) => build(inlineConfig).map(config => {
  if (config.name !== '@run-bigpig/dsh-desktop-plugin-client/client') return config
  return {
    ...config,
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
      },
      ...(config.plugins ?? []),
    ],
  }
})
