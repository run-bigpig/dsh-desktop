import { useState, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ImageResultTail, selectImageResultTail, type ImageResultTailInjected } from '../image/ImageResultTail.tsx'
import css from './CanvasResultTail.module.css'

export interface CanvasArtifact { kind: 'starweave-canvas'; path: string; name: string; hash: string; saved: true }
export interface BrowserArtifact { id: string; url: string; title: string }
interface SavedCanvas { seq: number; artifact: CanvasArtifact }
interface CanvasResults { files: readonly SavedCanvas[]; pages: readonly { seq: number; page: BrowserArtifact }[] }
interface CanvasState extends CanvasResults { turn: number; calls: ReadonlyMap<string, string> }
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap { 'desktop-canvas-results': CanvasResults }
}

export function parseCanvasArtifact(text: string): CanvasArtifact | null {
  try {
    const item = JSON.parse(text) as Partial<CanvasArtifact>
    return item?.kind === 'starweave-canvas' && item.saved === true && typeof item.path === 'string'
      && /\.fig$/iu.test(item.path) && typeof item.name === 'string' && typeof item.hash === 'string'
      ? item as CanvasArtifact : null
  } catch { return null }
}

export const canvasResultDefinition: ConversationNodeDefinition<CanvasState> = {
  kind: 'desktop-canvas-results',
  match: event => event.type === 'turn/start' ? { id: String(event.data.turn), role: 'start' }
    : event.type === 'tool/call' || event.type === 'tool/result' ? { id: String(event.data.turn), role: 'update' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('Canvas results require turn/start')
    return { turn: match.event.data.turn, calls: new Map(), files: [], pages: [] }
  },
  update: ({ state }, { event }) => {
    if (event.type === 'tool/call' && ['save_canvas', 'workspace_browser'].includes(event.data.name)) {
      return { ...state, calls: new Map([...state.calls, [String(event.data.callId), event.data.name]]) }
    }
    if (event.type !== 'tool/result' || !state.calls.has(String(event.data.message.source.callId))) return state
    const result = event.data.message.content.find(block => block.type === 'tool-result')
    if (!result || result.isError) return state
    const tool = state.calls.get(String(event.data.message.source.callId))
    const files = tool === 'save_canvas' ? result.content.flatMap(content => {
      const artifact = content.type === 'text' ? parseCanvasArtifact(content.text) : null
      return artifact ? [{ seq: event.seq, artifact }] : []
    }) : []
    const pages = tool === 'workspace_browser' ? result.content.flatMap(content => {
      const page = content.type === 'text' ? parseBrowserArtifact(content.text) : null
      return page ? [{ seq: event.seq, page }] : []
    }) : []
    return { ...state, files: [...state.files, ...files], pages: [...state.pages, ...pages] }
  },
  buildLocationData: ({ state }, scope) => scope === 'turn' && state
    ? { kind: 'turn', turn: state.turn, key: 'desktop-canvas-results', value: { files: state.files, pages: state.pages } } : null,
}

interface Matched { images: readonly ImageAttachmentRef[]; canvases: readonly CanvasArtifact[]; pages?: readonly BrowserArtifact[] }
export interface ArtifactResultTailInjected extends ImageResultTailInjected {
  readonly openBrowserPage: (sessionId: string, page: BrowserArtifact) => Promise<void>
  readonly openCanvasFile: (sessionId: string, path: string, reloadFromDisk?: boolean) => Promise<void>
}
export function selectArtifactResultTail(owner: TurnTailOwnerProps): Matched | null {
  const images = selectImageResultTail(owner) ?? []
  const files = owner.turn.data.get('desktop-canvas-results')?.files.filter(file => file.seq <= owner.seq) ?? []
  const canvases = [...new Map(files.map(file => [file.artifact.path, file.artifact])).values()]
  const pages = [...new Map((owner.turn.data.get('desktop-canvas-results')?.pages ?? []).filter(item => item.seq <= owner.seq).map(item => [item.page.id, item.page])).values()]
  return images.length || canvases.length || pages.length ? { images, canvases, pages } : null
}

export function ArtifactResultTail(props: PropsRuntime<'conversation.chat.turnTail'> & { matched: Matched }
  & PropsLocale<'desktop.workbench'> & InjectFace<ArtifactResultTailInjected>): ReactNode {
  return <>
    {props.matched.images.length > 0 && <ImageResultTail {...props} matched={props.matched.images} />}
    {props.matched.pages?.map(page => <BrowserCard key={page.id} page={page} open={() => props.openBrowserPage(String(props.sessionId), page)} />)}
    {props.matched.canvases.map(artifact => <CanvasCard key={artifact.path} artifact={artifact}
      open={reloadFromDisk => props.openCanvasFile(String(props.sessionId), artifact.path, reloadFromDisk)} />)}
  </>
}

function CanvasCard({ artifact, open }: { artifact: CanvasArtifact; open: (reloadFromDisk?: boolean) => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className={css.result}>
    <button className={css.card} type="button" disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void open().catch(reason => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
    }}>
      <span className={css.icon} aria-hidden="true">FIG</span>
      <span><strong>{artifact.name}</strong><small>{artifact.path}</small></span>
      <small>{busy ? '正在打开…' : '已保存 · 打开画布'}</small>
    </button>
    {error && <p role="alert">{error}<button type="button" disabled={busy} onClick={() => {
      if (!window.confirm('保留当前恢复快照并重新读取磁盘上的设计文件？')) return
      setBusy(true)
      void open(true).then(() => { setError('') }, reason => { setError(String(reason)) }).finally(() => { setBusy(false) })
    }}>重新读取磁盘文件</button></p>}
  </div>
}

function parseBrowserArtifact(text: string): BrowserArtifact | null {
  try {
    const page = JSON.parse(text) as Partial<BrowserArtifact>
    return typeof page?.id === 'string' && typeof page.url === 'string' && /^https?:\/\//iu.test(page.url)
      ? { id: page.id, url: page.url, title: page.title || page.url } : null
  } catch { return null }
}

function BrowserCard({ page, open }: { page: BrowserArtifact; open: () => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className={css.result}>
    <button className={css.card} type="button" disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void open().catch(reason => { setError(String(reason)) }).finally(() => { setBusy(false) })
    }}>
      <span className={css.icon} aria-hidden="true">↗</span><span><strong>{page.title}</strong><small>{page.url}</small></span>
      <small>{busy ? '正在打开…' : '打开网页'}</small>
    </button>
    {error && <p role="alert">{error}</p>}
  </div>
}
