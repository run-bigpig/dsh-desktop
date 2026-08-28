const BODY_STYLE_PROPERTIES = [
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundAttachment',
] as const

type BodyStyleProperty = typeof BODY_STYLE_PROPERTIES[number]

/** Reversible presenter for the one global surface Theme Runtime cannot own: the page background image. */
export class SkinBackgroundPresenter {
  private previous: Record<BodyStyleProperty, string> | undefined
  private applied: Record<BodyStyleProperty, string> | undefined

  set(image: string | undefined): void {
    if (typeof document === 'undefined') return
    if (image === undefined) {
      this.restore()
      return
    }
    const style = document.body.style
    if (this.previous === undefined) {
      this.previous = Object.fromEntries(BODY_STYLE_PROPERTIES.map(property => [property, style[property]])) as Record<BodyStyleProperty, string>
    }
    const applied: Record<BodyStyleProperty, string> = {
      backgroundImage: `url(${JSON.stringify(image)})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundAttachment: 'fixed',
    }
    for (const property of BODY_STYLE_PROPERTIES) style[property] = applied[property]
    this.applied = Object.fromEntries(BODY_STYLE_PROPERTIES.map(property => [property, style[property]])) as Record<BodyStyleProperty, string>
  }

  dispose(): void {
    this.restore()
  }

  private restore(): void {
    if (typeof document === 'undefined' || this.previous === undefined || this.applied === undefined) return
    const style = document.body.style
    for (const property of BODY_STYLE_PROPERTIES) {
      if (style[property] === this.applied[property]) style[property] = this.previous[property]
    }
    this.previous = undefined
    this.applied = undefined
  }
}
