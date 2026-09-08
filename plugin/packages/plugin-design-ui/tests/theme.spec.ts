import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8')

describe('design surface theme', () => {
  it('inherits Harness semantic tokens throughout the shadow-root editor', () => {
    for (const token of [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-label-primary',
      '--dsw-alias-border-l2',
      '--dsw-alias-state-business-primary',
    ]) expect(css).toContain(token)

    expect(css).toMatch(/\.design-root[^}]+background: var\(--design-bg-base\)/u)
    expect(css).toMatch(/\.canvas-wrap[^}]+background-color: color-mix\([^;]+--design-bg-base/u)
    expect(css.slice(css.indexOf('button, input'))).not.toMatch(/#[\da-f]{3,8}\b/iu)
  })
})
