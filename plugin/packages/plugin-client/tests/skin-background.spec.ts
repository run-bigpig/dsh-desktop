// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { SkinBackgroundPresenter } from '../src/client/skin/skin-background.ts'

afterEach(() => { document.body.removeAttribute('style') })

describe('SkinBackgroundPresenter', () => {
  it('applies, replaces, and restores body background styles without overwriting later owners', () => {
    document.body.style.backgroundPosition = 'left top'
    const presenter = new SkinBackgroundPresenter()
    presenter.set('data:image/png;base64,AA==')
    expect(document.body.style.backgroundImage).toContain('data:image/png;base64,AA==')
    expect(document.body.style.backgroundSize).toBe('cover')

    presenter.set('data:image/webp;base64,BB==')
    expect(document.body.style.backgroundImage).toContain('data:image/webp;base64,BB==')
    document.body.style.backgroundRepeat = 'repeat-x'
    presenter.dispose()

    expect(document.body.style.backgroundImage).toBe('')
    expect(document.body.style.backgroundPosition).toBe('left top')
    expect(document.body.style.backgroundRepeat).toBe('repeat-x')
  })
})
