// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyUploadFiles,
  documentReferenceOf,
  DocumentUploadBridge,
  DocumentUploadButton,
  type DocumentUploadButtonProps,
  DOCUMENT_REFERENCE_SOURCE,
  type DocumentUploadBridgeProps,
} from '../src/client/documents/DocumentUploadBridge.tsx'
import { DocumentMessageView, extractDocumentMessage, type DocumentMessageProps } from '../src/client/documents/DocumentMessageView.tsx'
import { documentsEn } from '../src/client/locales.ts'

const DOCUMENT_ID = `sha256:${'a'.repeat(64)}`
const DOCUMENT_MARKER = `[Document: TStoreProduct(17).xlsx | id=${DOCUMENT_ID} | 1360 chars]`

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function translate(key: keyof typeof documentsEn, params?: Readonly<Record<string, unknown>>): string {
  let text = documentsEn[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

function inputState(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    draft: '',
    imageIds: [],
    draftRev: 1,
    phase: 'plain',
    occurrences: [],
    queue: [],
    ...overrides,
  }
}

function bridgeProps(state: ReturnType<typeof inputState>, overrides: Partial<DocumentUploadBridgeProps> = {}) {
  return {
    useInput: (selector: (value: typeof state) => unknown) => selector(state),
    inputActions: { setDraft: vi.fn() },
    uploadDocument: vi.fn(),
    insertDocument: vi.fn().mockReturnValue(true),
    bindPicker: vi.fn().mockReturnValue(() => {}),
    t: translate,
    ...overrides,
  } as unknown as DocumentUploadBridgeProps
}

describe('document upload bridge', () => {
  it('normalizes a PNG with a missing browser MIME before native image intake', () => {
    const file = new File([Uint8Array.of(1, 2, 3)], 'capture.PNG', { type: '' })
    const batch = classifyUploadFiles([file])

    expect(batch.documents).toHaveLength(0)
    expect(batch.unsupported).toHaveLength(0)
    expect(batch.images).toHaveLength(1)
    expect(batch.images[0]?.type).toBe('image/png')
    expect(batch.needsInterception).toBe(true)
  })

  it('leaves a canonical PNG to the native image drop path', () => {
    const file = new File([Uint8Array.of(1)], 'capture.png', { type: 'image/png' })
    const batch = classifyUploadFiles([file])

    expect(batch.images).toEqual([file])
    expect(batch.needsInterception).toBe(false)
  })

  it('serializes an uploaded document through the Harness reference codec', () => {
    expect(documentReferenceOf({
      id: DOCUMENT_ID,
      name: 'TStoreProduct(17).xlsx',
      marker: DOCUMENT_MARKER,
    })).toEqual({
      source: DOCUMENT_REFERENCE_SOURCE,
      ref: DOCUMENT_MARKER,
      label: '\u2060',
      clipboardText: DOCUMENT_MARKER,
    })
  })

  it('uploads a document as a reference instead of appending its marker to the visible draft', async () => {
    let openPicker: (() => void) | undefined
    const state = inputState({ draft: 'summarize', draftRev: 7 })
    const setDraft = vi.fn()
    const insertDocument = vi.fn().mockReturnValue(true)
    const uploadDocument = vi.fn().mockResolvedValue({
      id: DOCUMENT_ID,
      name: 'TStoreProduct(17).xlsx',
      sourceBytes: 3,
      markdownCharacters: 1360,
      marker: DOCUMENT_MARKER,
    })
    const props = bridgeProps(state, {
      inputActions: { setDraft },
      uploadDocument,
      insertDocument,
      bindPicker: (open) => {
        openPicker = open
        return () => { openPicker = undefined }
      },
    })

    const view = render(<DocumentUploadBridge {...props} />)
    await waitFor(() => { expect(openPicker).toBeTypeOf('function') })
    openPicker?.()
    const picker = view.container.querySelector<HTMLInputElement>('[data-document-upload-picker]')
    expect(picker?.accept).toContain('.xlsx')

    fireEvent.change(picker as HTMLInputElement, {
      target: { files: [new File([Uint8Array.of(1, 2, 3)], 'TStoreProduct(17).xlsx')] },
    })

    await waitFor(() => {
      expect(uploadDocument).toHaveBeenCalledWith(expect.objectContaining({ name: 'TStoreProduct(17).xlsx' }))
      expect(insertDocument).toHaveBeenCalledWith(expect.objectContaining({ marker: DOCUMENT_MARKER }), {
        start: 9,
        end: 9,
        draftRev: 7,
      })
    })
    expect(setDraft).not.toHaveBeenCalled()
    expect(view.queryByText(DOCUMENT_MARKER)).toBeNull()
  })

  it('renders an uploaded document as a thumbnail and removes its placeholder as one attachment', () => {
    const setDraft = vi.fn()
    const state = inputState({
      draft: `summarize\uFFFC `,
      occurrences: [{
        occurrenceId: 41,
        source: DOCUMENT_REFERENCE_SOURCE,
        ref: DOCUMENT_MARKER,
        offset: 9,
        length: 1,
        label: 'XLSX',
        clipboardText: DOCUMENT_MARKER,
      }],
    })
    const view = render(<DocumentUploadBridge {...bridgeProps(state, { inputActions: { setDraft } })} />)

    expect(view.getByLabelText('TStoreProduct(17).xlsx')).toBeTruthy()
    expect(view.getByText('XLSX')).toBeTruthy()
    expect(view.getByText('TStoreProduct(17).xlsx')).toBeTruthy()
    expect(view.queryByText(DOCUMENT_MARKER)).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Remove document TStoreProduct(17).xlsx' }))
    expect(setDraft).toHaveBeenCalledWith('summarize')
  })

  it('hides the duplicate composer reference chip while keeping the attachment rail', () => {
    const state = inputState({
      draft: '\uFFFC',
      occurrences: [{
        occurrenceId: 41,
        source: DOCUMENT_REFERENCE_SOURCE,
        ref: DOCUMENT_MARKER,
        offset: 0,
        length: 1,
        label: 'XLSX',
        clipboardText: DOCUMENT_MARKER,
      }],
    })
    const view = render(
      <div>
        <DocumentUploadBridge {...bridgeProps(state)} />
        <div data-composer-card=""><span data-decoration="chip" data-occurrence="41"><span>XLSX</span></span></div>
      </div>,
    )

    expect(view.container.querySelector('[data-occurrence="41"]')?.hasAttribute('data-desktop-document-chip')).toBe(true)
    expect(view.getByText('TStoreProduct(17).xlsx')).toBeTruthy()
  })

  it('upgrades a persisted legacy marker back into a reference occurrence', async () => {
    const insertDocument = vi.fn().mockReturnValue(true)
    const draft = `before ${DOCUMENT_MARKER} after`
    render(<DocumentUploadBridge {...bridgeProps(inputState({ draft, draftRev: 11 }), { insertDocument })} />)

    await waitFor(() => {
      expect(insertDocument).toHaveBeenCalledWith(expect.objectContaining({ marker: DOCUMENT_MARKER }), {
        start: 7,
        end: 7 + DOCUMENT_MARKER.length,
        draftRev: 11,
      })
    })
  })
})

describe('sent document messages', () => {
  it('extracts document markers without exposing them as visible message text', () => {
    expect(extractDocumentMessage(`Please review\n${DOCUMENT_MARKER}`)).toEqual({
      text: 'Please review',
      documents: [{ id: DOCUMENT_ID, name: 'TStoreProduct(17).xlsx', marker: DOCUMENT_MARKER }],
    })
  })

  it('renders the sent document as a named attachment card', () => {
    const props = {
      node: {
        kind: 'user',
        data: {
          content: [{ type: 'text', text: `Please review\n${DOCUMENT_MARKER}` }],
          time: Date.now(),
        },
      },
      renderMessageImages: vi.fn(() => null),
      t: (key: string) => key,
      documentT: translate,
    } as unknown as DocumentMessageProps
    const view = render(<DocumentMessageView {...props} />)

    expect(view.getByText('Please review')).toBeTruthy()
    expect(view.getByText('TStoreProduct(17).xlsx')).toBeTruthy()
    expect(view.getByText('XLSX')).toBeTruthy()
    expect(view.container.querySelector('[data-document-message-attachment]')).not.toBeNull()
    expect(view.queryByText(DOCUMENT_MARKER)).toBeNull()
  })
})

describe('document upload button', () => {
  it('follows the Harness input selector through busy and ready states', () => {
    const openPicker = vi.fn()
    const props = (phase: string) => ({
      useInput: (selector: (state: ReturnType<typeof inputState>) => unknown) => selector(inputState({ phase })),
      openPicker,
      t: translate,
    } as unknown as DocumentUploadButtonProps)
    const view = render(<DocumentUploadButton {...props('plain')} />)
    const button = view.getByRole('button', { name: translate('upload') }) as HTMLButtonElement
    fireEvent.click(button)
    expect(openPicker).toHaveBeenCalledTimes(1)

    for (const phase of ['adjudicating', 'submitting']) {
      view.rerender(<DocumentUploadButton {...props(phase)} />)
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
      expect(openPicker).toHaveBeenCalledTimes(1)
    }

    view.rerender(<DocumentUploadButton {...props('plain')} />)
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(openPicker).toHaveBeenCalledTimes(2)
  })
})
