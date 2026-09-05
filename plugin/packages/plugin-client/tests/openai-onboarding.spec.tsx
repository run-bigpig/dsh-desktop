// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAIOnboarding } from '../src/client/openai-onboarding.tsx'
afterEach(cleanup)
const props = () => ({ stepId: 'desktop-openai', openSection: vi.fn(), complete: vi.fn(),
  inspect: vi.fn(async () => 'prompt' as const), save: vi.fn(async (_key: string) => {}), t: ((key: string) => key) as never })
it('saves a trimmed secret through the credential callback and completes only after success', async () => {
  const p = props()
  render(<OpenAIOnboarding {...p} />)
  const input = await screen.findByLabelText('key')
  expect(input.getAttribute('type')).toBe('password')
  fireEvent.change(input, { target: { value: '  sk-test-only  ' } })
  fireEvent.click(screen.getByText('save'))
  await waitFor(() => expect(p.complete).toHaveBeenCalledOnce())
  expect(p.save).toHaveBeenCalledWith('sk-test-only')
})
it('rejects empty/invalid keys and keeps failed saves open for retry', async () => {
  const p = props()
  p.save.mockRejectedValueOnce(new Error('storage unavailable'))
  render(<OpenAIOnboarding {...p} />)
  const input = await screen.findByLabelText('key')
  fireEvent.click(screen.getByText('save'))
  expect(p.save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toBe('invalid')
  fireEvent.change(input, { target: { value: 'sk-test' } })
  fireEvent.click(screen.getByText('save'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))
  expect(p.complete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('save'))
  await waitFor(() => expect(p.complete).toHaveBeenCalledOnce())
})
it('skips configured or non-seeded providers without showing a dialog', async () => {
  const p = { ...props(), inspect: vi.fn(async () => 'skip' as const) }
  render(<OpenAIOnboarding {...p} />)
  await waitFor(() => expect(p.complete).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(p.save).not.toHaveBeenCalled()
})
it('supports retry after inspection failure and later without saving', async () => {
  const p = props()
  p.inspect.mockRejectedValueOnce(new Error('offline'))
  render(<OpenAIOnboarding {...p} />)
  fireEvent.click(await screen.findByText('retry'))
  await screen.findByLabelText('key')
  fireEvent.click(screen.getByText('later'))
  expect(p.complete).toHaveBeenCalledOnce()
  expect(p.save).not.toHaveBeenCalled()
})
