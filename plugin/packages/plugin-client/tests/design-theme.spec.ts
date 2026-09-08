import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/design/DesignConversationView.module.css', import.meta.url)), 'utf8')

it('uses Harness theme tokens for the design surface before the editor mounts', () => {
  expect(css).toContain('background: var(--dsw-alias-bg-base)')
  expect(css).toContain('color: var(--dsw-alias-label-secondary)')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu)
})
