import { clientBundle } from '../../client/tsdown.client.ts'
import { resolve } from 'node:path'

const build = clientBundle('@run-bigpig/dsh-desktop-plugin-client', ['lib/types/index.js'])
const yogaAdapter = resolve(import.meta.dirname, 'src/client/openpencil/yoga.ts')

export default (inlineConfig: Parameters<typeof build>[0]) => build(inlineConfig).map(config => {
  if (config.name !== '@run-bigpig/dsh-desktop-plugin-client/client') return config
  return {
    ...config,
    plugins: [
      {
        name: 'starweave-openpencil-yoga-adapter',
        resolveId(source: string) {
          return source === 'yoga-layout' ? yogaAdapter : null
        },
      },
      ...(config.plugins ?? []),
    ],
  }
})
