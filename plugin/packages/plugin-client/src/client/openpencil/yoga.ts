import { loadYoga } from 'yoga-layout/load'

export * from 'yoga-layout/load'

type YogaRuntime = Awaited<ReturnType<typeof loadYoga>>
type YogaConfig = ReturnType<YogaRuntime['Config']['create']>

interface DeferredConfig {
  value?: YogaConfig
  readonly calls: Array<{ readonly property: PropertyKey, readonly args: readonly unknown[] }>
}

let runtime: YogaRuntime | undefined
let loading: Promise<void> | undefined
const deferredConfigs = new Set<DeferredConfig>()

const deferredConfigFactory = {
  create: (): YogaConfig => {
    const deferred: DeferredConfig = { calls: [] }
    let proxy: YogaConfig
    proxy = new Proxy({} as YogaConfig, {
      get(_target, property) {
        if (deferred.value !== undefined) {
          const value = Reflect.get(deferred.value, property, deferred.value)
          return typeof value === 'function' ? value.bind(deferred.value) : value
        }
        return (...args: readonly unknown[]) => {
          deferred.calls.push({ property, args })
          return proxy
        }
      },
    })
    deferredConfigs.add(deferred)
    return proxy
  },
}

const Yoga = new Proxy({} as YogaRuntime, {
  get(_target, property) {
    if (runtime === undefined && property === 'Config') return deferredConfigFactory
    if (runtime === undefined) throw new Error('OpenPencil Yoga runtime was used before initialization')
    return runtime[property as keyof YogaRuntime]
  },
})

export async function initializeOpenPencilYoga(): Promise<void> {
  loading ??= loadYoga().then(value => {
    runtime = value
    for (const deferred of deferredConfigs) {
      deferred.value = value.Config.create()
      for (const call of deferred.calls) {
        const method = Reflect.get(deferred.value, call.property, deferred.value)
        if (typeof method !== 'function') throw new Error(`OpenPencil Yoga Config.${String(call.property)} is not callable`)
        Reflect.apply(method, deferred.value, call.args)
      }
      deferred.calls.length = 0
    }
    deferredConfigs.clear()
  })
  await loading
}

export default Yoga
