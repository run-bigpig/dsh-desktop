import { fontManager } from '@open-pencil/core/text'

interface DesktopFonts {
  readonly family: string
  load(): Promise<ArrayBuffer>
}

declare global {
  interface Window { readonly __STARWEAVE_DESIGN_FONTS__?: DesktopFonts }
}

export const desktopFontsReady = 'starweave:design-fonts-ready'
let loading: Promise<void> | undefined

// Register through OpenPencil so every CanvasKit provider, text editor and
// export renderer gets the same fallback, including providers attached later.
export function loadDesktopFonts(): Promise<void> {
  const fonts = window.__STARWEAVE_DESIGN_FONTS__
  if (!fonts) return Promise.resolve()
  if (!loading) {
    loading = fonts.load().then(data => {
      fontManager.markLoaded(fonts.family, 'Regular', data)
      fontManager.setCJKFallbackFamily(fonts.family)
    }).catch(error => {
      loading = undefined
      throw error
    })
  }
  return loading
}

export async function loadDesktopFont(family: string, style: string): Promise<ArrayBuffer | null> {
  const fonts = window.__STARWEAVE_DESIGN_FONTS__
  if (!fonts || family !== fonts.family || style !== 'Regular') return null
  await loadDesktopFonts()
  return fontManager.loadedData(family, style)
}
