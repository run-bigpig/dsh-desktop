import { loadYoga } from 'yoga-layout/load'

export * from 'yoga-layout/load'

type YogaRuntime = Awaited<ReturnType<typeof loadYoga>>

let runtime: YogaRuntime | undefined
let loading: Promise<void> | undefined

const Yoga = new Proxy({} as YogaRuntime, {
  get(_target, property) {
    if (runtime === undefined) throw new Error('OpenPencil Yoga runtime was used before initialization')
    return runtime[property as keyof YogaRuntime]
  },
})

export async function initializeOpenPencilYoga(): Promise<void> {
  loading ??= loadYoga().then(value => { runtime = value })
  await loading
}

export default Yoga
