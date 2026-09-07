// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DesignConversationSplit, type DesignConnection } from '../src/client/design/DesignConversationView.tsx'

afterEach(cleanup)

describe('design conversation split', () => {
  it('places the canvas beside the native conversation scrollport and cleans it up', () => {
    const conversation = document.createElement('div')
    conversation.dataset.slot = 'conversation'
    const tablist = document.createElement('div')
    tablist.setAttribute('role', 'tablist')
    const chatTab = document.createElement('button')
    chatTab.setAttribute('role', 'tab')
    chatTab.textContent = '对话'
    const trajectoryTab = document.createElement('button')
    trajectoryTab.setAttribute('role', 'tab')
    trajectoryTab.textContent = '轨迹'
    tablist.append(chatTab, trajectoryTab)
    const layout = document.createElement('div')
    const scroll = document.createElement('div')
    const dock = document.createElement('div')
    scroll.dataset.conversationScroll = ''
    scroll.append(dock)
    layout.append(scroll)
    conversation.append(tablist, layout)
    document.body.append(conversation)

    const connect = vi.fn(() => new Promise<DesignConnection>(() => undefined))
    const view = render(<DesignConversationSplit connect={connect} />, { container: dock })

    const canvas = layout.querySelector<HTMLElement>('[data-starweave-design-canvas]')
    expect(layout.dataset.starweaveDesignLayout).toBe('')
    expect(canvas).not.toBeNull()
    expect(layout.firstElementChild).toBe(canvas)
    expect(layout.lastElementChild).toBe(scroll)
    expect(connect).toHaveBeenCalledOnce()
    expect(chatTab.textContent).toBe('设计')
    expect(chatTab.getAttribute('aria-label')).toBe('设计')
    expect(trajectoryTab.textContent).toBe('轨迹')

    view.unmount()
    expect(layout.querySelector('[data-starweave-design-canvas]')).toBeNull()
    expect(layout.hasAttribute('data-starweave-design-layout')).toBe(false)
    expect(chatTab.textContent).toBe('对话')
    expect(chatTab.hasAttribute('aria-label')).toBe(false)
    conversation.remove()
  })
})
