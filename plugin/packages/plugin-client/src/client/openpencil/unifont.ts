interface DisabledUnifont {
  readonly listFonts: () => Promise<readonly string[]>
  readonly resolveFont: () => Promise<{ readonly fonts: readonly never[] }>
}

const disabledProvider = (): Record<string, never> => ({})

export const providers = {
  google: disabledProvider,
  fontsource: disabledProvider,
  bunny: disabledProvider,
  fontshare: disabledProvider,
}

export async function createUnifont(): Promise<DisabledUnifont> {
  return {
    listFonts: async () => [],
    resolveFont: async () => ({ fonts: [] }),
  }
}
