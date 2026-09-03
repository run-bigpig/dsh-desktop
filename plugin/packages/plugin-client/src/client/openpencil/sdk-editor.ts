import {
  computed,
  createApp,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowReactive,
  type Component,
} from 'vue'
import { getCanvasKit } from '@open-pencil/core/canvaskit'
import { renderTreeNode } from '@open-pencil/core/design-jsx'
import { createDefaultEditorState, createEditor, EDITOR_TOOLS, type Editor } from '@open-pencil/core/editor'
import { FigmaAPI } from '@open-pencil/core/figma-api'
import {
  exportFigFile,
  readFigFile,
  renderNodesToImage,
  sceneNodeToJSX,
  selectionToJSX,
  type RasterExportFormat,
} from '@open-pencil/core/io'
import { computeAllLayouts } from '@open-pencil/core/layout'
import { executeRPCCommand } from '@open-pencil/core/rpc'
import { fontManager } from '@open-pencil/core/text'
import { ALL_TOOLS } from '@open-pencil/core/tools'
import {
  provideEditor,
  useCanvas,
  useCanvasInput,
  useEditor,
  usePageList,
  usePosition,
  useSelectionState,
} from '@open-pencil/vue'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import type { OpenPencilCollaborationHostSession } from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './OpenPencilIntegration.module.css'
import {
  createOpenPencilCollaboration,
  type CollaborationSnapshot,
} from './collaboration.ts'
import { initializeOpenPencilYoga } from './yoga.ts'

export interface OpenPencilSDKBridge {
  readonly port: number
  readonly authToken: string
  readonly canvasKitWasmBase64: string
  readonly fontAsset: (family: string, style: string) => Promise<string | null>
  readonly startCollaboration: () => Promise<OpenPencilCollaborationHostSession>
  readonly stopCollaboration: (hostKey: string) => Promise<void>
  readonly readFile: (path: string, signal: AbortSignal) => Promise<{ readonly path: string; readonly dataBase64: string }>
  readonly writeFile: (path: string, dataBase64: string, signal: AbortSignal) => Promise<{ readonly path: string }>
  readonly close: () => void
}

const DOCUMENT_ID = 'starweave-canvas'
const TOOL_LABELS: Readonly<Record<string, string>> = {
  SELECT: '选择', FRAME: '画框', RECTANGLE: '矩形', PEN: '钢笔', TEXT: '文字', HAND: '移动',
}

export async function mountOpenPencilSDK(
  container: HTMLElement,
  bridge: OpenPencilSDKBridge,
): Promise<() => void> {
  fontManager.setHostFontLoader(async (family, style) => {
    const encoded = await bridge.fontAsset(family, style)
    return encoded === null ? null : ownedArrayBuffer(base64ToBytes(encoded))
  })
  try {
    await initializeOpenPencilYoga()
    const wasm = base64ToBytes(bridge.canvasKitWasmBase64)
    const wasmURL = URL.createObjectURL(new Blob([ownedArrayBuffer(wasm)], { type: 'application/wasm' }))
    try {
      await getCanvasKit({ locateFile: () => wasmURL })
    } finally {
      URL.revokeObjectURL(wasmURL)
    }
    const app = createApp(createEditorShell(bridge))
    app.mount(container)
    return () => {
      app.unmount()
      fontManager.setHostFontLoader(null)
    }
  } catch (error) {
    fontManager.setHostFontLoader(null)
    throw error
  }
}

function createEditorShell(bridge: OpenPencilSDKBridge): Component {
  return defineComponent({
    name: 'StarWeaveOpenPencilEditor',
    setup() {
      const graph = new SceneGraph()
      const state = shallowReactive(createDefaultEditorState(graph.getPages()[0].id))
      const editor = createEditor({ graph, state })
      provideEditor(editor)

      const collaborationState = shallowReactive<CollaborationSnapshot>({
        active: false, connected: false, roomId: null, peerCount: 0, joinCodes: [],
      })
      const collaboration = createOpenPencilCollaboration(editor, {
        start: bridge.startCollaboration,
        stop: bridge.stopCollaboration,
      }, snapshot => { Object.assign(collaborationState, snapshot) })
      const collaborationInput = ref('')
      const collaborationPanelOpen = ref(false)
      const documentName = ref('Untitled')
      const documentPath = ref<string | null>(null)
      const message = ref('就绪')
      const connected = ref(false)
      const fileInput = ref<HTMLInputElement | null>(null)
      const pages = usePageList()
      const selection = useSelectionState()
      const position = usePosition()
      const automation = connectAutomation(editor, bridge, {
        documentName,
        documentPath,
        connected,
        message,
        isCollaborationActive: collaboration.isActive,
      })

      const currentLayers = computed(() => {
        void state.sceneVersion
        return editor.graph.getChildren(state.currentPageId)
      })

      const replaceDocument = async (file: File, path: string | null): Promise<void> => {
        if (collaboration.isActive()) throw new Error('请先离开协作房间，再打开其他设计文件')
        message.value = `正在打开 ${file.name}`
        const imported = await readFigFile(file, { populate: 'first-page' })
        const pageId = imported.getPages()[0]?.id
        if (pageId) computeAllLayouts(imported, pageId)
        editor.replaceGraph(imported)
        documentName.value = file.name.replace(/\.fig$/iu, '')
        documentPath.value = path
        await nextTick()
        editor.zoomToFit()
        message.value = '已打开'
      }

      const openLocalFile = async (event: Event): Promise<void> => {
        const input = event.currentTarget as HTMLInputElement
        const file = input.files?.[0]
        input.value = ''
        if (!file) return
        try {
          await replaceDocument(file, null)
        } catch (error) {
          message.value = errorMessage(error)
        }
      }

      const saveLocalFile = async (): Promise<void> => {
        try {
          const bytes = await exportFigFile(editor.graph, undefined, editor.renderer ?? undefined, state.currentPageId)
          if (documentPath.value) {
            const result = await bridge.writeFile(documentPath.value, bytesToBase64(bytes), AbortSignal.timeout(30_000))
            documentPath.value = result.path
            message.value = `已保存 ${result.path}`
            return
          }
          download(bytes, `${documentName.value || 'Untitled'}.fig`)
          message.value = '已下载设计文件'
        } catch (error) {
          message.value = errorMessage(error)
        }
      }

      const newDocument = (): void => {
        if (collaboration.isActive()) {
          message.value = '请先离开协作房间，再新建设计'
          return
        }
        const next = new SceneGraph()
        editor.replaceGraph(next)
        documentName.value = 'Untitled'
        documentPath.value = null
        message.value = '已新建设计'
      }

      const shareDocument = async (): Promise<void> => {
        try {
          const joinCodes = await collaboration.share()
          const joinCode = joinCodes[0]
          if (!joinCode) throw new Error('未检测到可用的内网地址')
          collaborationInput.value = joinCode
          await copyText(joinCode)
          message.value = '内网连接码已复制'
        } catch (error) {
          message.value = errorMessage(error)
        }
      }

      const joinCollaboration = async (): Promise<void> => {
        try {
          const joinCode = await collaboration.join(collaborationInput.value)
          collaborationInput.value = joinCode
          message.value = '正在连接内网协作房间'
        } catch (error) {
          message.value = errorMessage(error)
        }
      }

      const copyCollaborationLink = async (selected?: string): Promise<void> => {
        const joinCode = selected ?? collaborationState.joinCodes[0]
        if (!joinCode) return
        try {
          await copyText(joinCode)
          message.value = '内网连接码已复制'
        } catch (error) {
          message.value = errorMessage(error)
        }
      }

      const leaveCollaboration = async (): Promise<void> => {
        await collaboration.leave()
        collaborationPanelOpen.value = false
        message.value = '已离开协作房间'
      }

      const keydown = (event: KeyboardEvent): void => {
        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
          event.preventDefault()
          void saveLocalFile()
        }
        const mapped = EDITOR_TOOLS.find(tool => `Key${tool.shortcut}` === event.code)
        if (!event.ctrlKey && !event.metaKey && !event.altKey && mapped) editor.setTool(mapped.key)
      }

      onMounted(() => { window.addEventListener('keydown', keydown) })
      onBeforeUnmount(() => {
        window.removeEventListener('keydown', keydown)
        void collaboration.leave()
        automation.disconnect()
      })

      const renderLayer = (node: SceneNode, depth = 0): ReturnType<typeof h> => h('div', { key: node.id }, [
        h('button', {
          class: css.layer,
          'data-active': state.selectedIds.has(node.id) || undefined,
          style: { paddingLeft: `${9 + depth * 13}px` },
          type: 'button',
          onClick: (event: MouseEvent) => editor.select([node.id], event.shiftKey),
        }, [
          h('span', { class: css.nodeType }, node.type.slice(0, 2)),
          h('span', { class: css.nodeName }, node.name),
        ]),
        ...node.childIds
          .map(id => editor.graph.getNode(id))
          .filter((child): child is SceneNode => child !== undefined)
          .map(child => renderLayer(child, depth + 1)),
      ])

      const numericField = (label: string, key: 'x' | 'y' | 'width' | 'height', value: number) => h('div', { class: css.field }, [
        h('label', label),
        h('input', {
          type: 'number', value: Math.round(value * 100) / 100,
          onChange: (event: Event) => {
            const node = position.node.value
            const next = Number((event.currentTarget as HTMLInputElement).value)
            if (node && Number.isFinite(next)) editor.updateNodeWithUndo(node.id, { [key]: next }, `Set ${key}`)
          },
        }),
      ])

      return () => h('div', { class: css.sdkRoot }, [
        h('header', { class: css.topbar }, [
          h('div', { class: css.brand }, [
            h('div', { class: css.brandMark }, 'P'),
            h('div', { class: css.documentName, title: documentPath.value ?? documentName.value }, documentName.value),
          ]),
          h('div', { class: css.tools }, EDITOR_TOOLS.map(tool => h('button', {
            key: tool.key,
            class: css.tool,
            'data-active': state.activeTool === tool.key || undefined,
            type: 'button',
            title: `${tool.label} (${tool.shortcut})`,
            onClick: () => editor.setTool(tool.key),
          }, TOOL_LABELS[tool.key] ?? tool.label))),
          h('div', { class: css.actions }, [
            h('button', {
              class: css.action, type: 'button', disabled: collaborationState.active,
              title: collaborationState.active ? '请先离开协作房间' : undefined,
              onClick: newDocument,
            }, '新建'),
            h('button', {
              class: css.action, type: 'button', disabled: collaborationState.active,
              title: collaborationState.active ? '请先离开协作房间' : undefined,
              onClick: () => fileInput.value?.click(),
            }, '打开'),
            h('button', { class: css.action, type: 'button', onClick: () => void saveLocalFile() }, '保存'),
            h('div', { class: css.collaboration }, [
              h('button', {
                class: css.action,
                'data-active': collaborationState.active || undefined,
                type: 'button',
                onClick: () => { collaborationPanelOpen.value = !collaborationPanelOpen.value },
              }, collaborationState.active
                ? collaborationState.connected ? `在线 ${collaborationState.peerCount}` : '连接中'
                : '协作'),
              collaborationPanelOpen.value ? h('div', { class: css.collaborationPanel }, collaborationState.active ? [
                h('div', { class: css.collaborationHeading }, collaborationState.connected ? '内网协作已开启' : '正在连接内网房间'),
                h('div', { class: css.codeList }, collaborationState.joinCodes.length > 0
                  ? collaborationState.joinCodes.map(code => h('button', {
                      key: code,
                      class: css.roomId,
                      type: 'button',
                      title: '复制这个内网连接码',
                      onClick: () => void copyCollaborationLink(code),
                    }, code))
                  : [h('div', { class: css.roomId }, collaborationState.roomId ?? '')]),
                h('div', { class: css.collaborationHint }, collaborationState.connected
                  ? `${collaborationState.peerCount} 人在线 · 数据只通过局域网传输${collaborationState.joinCodes.length > 1 ? ` · ${collaborationState.joinCodes.length} 个可用地址` : ''}`
                  : '正在建立内网 WebSocket 连接…'),
                h('div', { class: css.collaborationButtons }, [
                  h('button', { class: css.primaryAction, type: 'button', onClick: () => void copyCollaborationLink() }, '复制连接码'),
                  h('button', { class: css.secondaryAction, type: 'button', onClick: () => void leaveCollaboration() }, '离开'),
                ]),
              ] : [
                h('div', { class: css.collaborationHeading }, '内网分享与协作'),
                h('div', { class: css.collaborationHint }, '创建临时内网房间分享当前设计，或输入另一台 StarWeave 提供的连接码。'),
                h('input', {
                  class: css.collaborationInput,
                  value: collaborationInput.value,
                  placeholder: 'openpencil-lan://…',
                  onInput: (event: Event) => { collaborationInput.value = (event.currentTarget as HTMLInputElement).value },
                  onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') void joinCollaboration() },
                }),
                h('div', { class: css.collaborationButtons }, [
                  h('button', { class: css.primaryAction, type: 'button', onClick: () => void shareDocument() }, '创建分享'),
                  h('button', { class: css.secondaryAction, type: 'button', onClick: () => void joinCollaboration() }, '加入'),
                ]),
              ]) : null,
            ]),
            h('button', { class: css.iconAction, type: 'button', title: '返回 StarWeave', onClick: bridge.close }, '×'),
            h('input', { ref: fileInput, class: css.fileInput, type: 'file', accept: '.fig', onChange: (event: Event) => void openLocalFile(event) }),
          ]),
        ]),
        h('div', { class: css.workspace }, [
          h('aside', { class: [css.panel, css.leftPanel] }, [
            h('section', { class: css.panelSection }, [
              h('div', { class: css.panelHeading }, [
                h('span', '页面'),
                h('button', { class: css.addPage, type: 'button', title: '添加页面', onClick: () => pages.addPage() }, '+'),
              ]),
              ...pages.pages.value.map(page => h('button', {
                key: page.id, class: css.page, 'data-active': page.id === pages.currentPageId.value || undefined,
                type: 'button', onClick: () => void pages.switchPage(page.id),
              }, page.name)),
            ]),
            h('section', { class: css.panelSection }, [
              h('div', { class: css.panelHeading }, '图层'),
              ...currentLayers.value.map(node => renderLayer(node)),
            ]),
          ]),
          h('main', { class: css.canvasWrap }, [h(CanvasPane)]),
          h('aside', { class: [css.panel, css.rightPanel] }, [
            h('div', { class: css.panelHeading }, '属性'),
            selection.selectedNode.value
              ? h('div', { class: css.fieldGrid }, [
                  h('div', { class: css.wideField }, [
                    h('label', '名称'),
                    h('input', {
                      value: selection.selectedNode.value.name,
                      onChange: (event: Event) => {
                        const node = selection.selectedNode.value
                        if (node) editor.renameNode(node.id, (event.currentTarget as HTMLInputElement).value)
                      },
                    }),
                  ]),
                  numericField('X', 'x', position.x.value),
                  numericField('Y', 'y', position.y.value),
                  numericField('宽度', 'width', position.width.value),
                  numericField('高度', 'height', position.height.value),
                ])
              : h('div', { class: css.emptyPanel }, '选择画布中的对象以编辑位置和尺寸。'),
          ]),
        ]),
        h('footer', { class: css.statusbar }, [
          h('div', { class: css.statusGroup }, [
            h('span', { class: css.statusDot, 'data-connected': connected.value || undefined }),
            h('span', connected.value ? 'MCP 已连接' : 'MCP 正在连接'),
          ]),
          h('span', message.value),
          h('span', `${Math.round(state.zoom * 100)}% · ${selection.selectedCount.value} 个选中`),
        ]),
      ])
    },
  })
}

const CanvasPane = defineComponent({
  name: 'OpenPencilCanvasPane',
  setup() {
    const editor = useEditor()
    const canvasRef = ref<HTMLCanvasElement | null>(null)
    const canvas = useCanvas(canvasRef, editor, { onReady: () => { editor.zoomToFit() } })
    const input = useCanvasInput(
      canvasRef,
      editor,
      canvas.hitTestSectionTitle,
      canvas.hitTestComponentLabel,
      canvas.hitTestFrameTitle,
    )
    return () => h('canvas', {
      ref: canvasRef,
      class: css.canvas,
      tabindex: 0,
      style: { cursor: input.cursorOverride.value ?? undefined },
    })
  },
})

interface AutomationState {
  readonly documentName: { value: string }
  readonly documentPath: { value: string | null }
  readonly connected: { value: boolean }
  readonly message: { value: string }
  readonly isCollaborationActive: () => boolean
}

function connectAutomation(editor: Editor, bridge: OpenPencilSDKBridge, state: AutomationState) {
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const target = (pageId = editor.state.currentPageId) => {
    const page = editor.graph.getNode(pageId)
    if (page?.type !== 'CANVAS') throw new Error(`Page ${pageId} not found`)
    return {
      documentId: DOCUMENT_ID,
      documentName: state.documentName.value,
      ...(state.documentPath.value ? { path: state.documentPath.value } : {}),
      pageId,
      pageName: page.name,
    }
  }

  const withTarget = (body: unknown, pageId?: string): Record<string, unknown> => ({
    ...(isRecord(body) ? body : { ok: true, result: body }),
    target: target(pageId),
  })

  const importPath = async (path: string): Promise<void> => {
    const source = await bridge.readFile(path, AbortSignal.timeout(30_000))
    const bytes = base64ToBytes(source.dataBase64)
    const name = source.path.split('/').pop() ?? 'design.fig'
    const imported = await readFigFile(new File([ownedArrayBuffer(bytes)], name), { populate: 'first-page' })
    const pageId = imported.getPages()[0]?.id
    if (pageId) computeAllLayouts(imported, pageId)
    editor.replaceGraph(imported)
    state.documentName.value = name.replace(/\.fig$/iu, '')
    state.documentPath.value = source.path
    await nextTick()
    editor.zoomToFit()
  }

  const savePath = async (path: string): Promise<string> => {
    const bytes = await exportFigFile(editor.graph, undefined, editor.renderer ?? undefined, editor.state.currentPageId)
    const result = await bridge.writeFile(path, bytesToBase64(bytes), AbortSignal.timeout(30_000))
    state.documentPath.value = result.path
    state.documentName.value = (result.path.split('/').pop() ?? 'Untitled.fig').replace(/\.fig$/iu, '')
    return result.path
  }

  const makeFigma = (pageId: string): FigmaAPI => {
    const api = new FigmaAPI(editor.graph)
    api.setRenderer(editor.renderer ?? null)
    api.currentPage = api.wrapNode(pageId)
    api.currentPage.selection = [...editor.state.selectedIds]
      .map(id => api.getNodeById(id))
      .filter((node): node is NonNullable<typeof node> => node !== null)
    api.viewport = {
      center: {
        x: (-editor.state.panX + window.innerWidth / 2) / editor.state.zoom,
        y: (-editor.state.panY + window.innerHeight / 2) / editor.state.zoom,
      },
      zoom: editor.state.zoom,
    }
    api.exportImage = async (nodeIds, options) => {
      const renderer = editor.renderer
      if (!renderer) throw new Error('Canvas renderer is not ready')
      return renderNodesToImage(
        await getCanvasKit(), renderer, editor.graph, pageId, nodeIds,
        { scale: options.scale ?? 1, format: options.format ?? 'PNG' },
      )
    }
    api.listAvailableFontsAsync = () => Promise.resolve([])
    return api
  }

  const handleRequest = async (command: string, args: unknown): Promise<unknown> => {
    const raw = isRecord(args) ? args : {}
    const requestedPage = typeof raw.page_id === 'string' ? raw.page_id : editor.state.currentPageId
    const { document_id: _documentId, page_id: _pageId, ...commandArgs } = raw

    if (command === 'list_documents') {
      const current = target()
      return { ok: true, result: { documents: [{
        id: DOCUMENT_ID,
        name: current.documentName,
        ...('path' in current ? { path: current.path } : {}),
        active: true,
        current_page_id: current.pageId,
        current_page_name: current.pageName,
        pages: editor.graph.getPages().map(page => ({ id: page.id, name: page.name })),
      }] } }
    }
    if (command === 'new_document') {
      if (state.isCollaborationActive()) throw new Error('请先离开协作房间，再新建设计')
      editor.replaceGraph(new SceneGraph())
      state.documentName.value = 'Untitled'
      state.documentPath.value = null
      const path = typeof commandArgs.path === 'string' ? commandArgs.path : null
      if (path) await savePath(path)
      return withTarget({ ok: true, result: { created: true } })
    }
    if (command === 'open_file') {
      if (state.isCollaborationActive()) throw new Error('请先离开协作房间，再打开其他设计文件')
      if (typeof commandArgs.path !== 'string') throw new Error('Missing "path" in args')
      await importPath(commandArgs.path)
      return withTarget({ ok: true, result: { opened: true } })
    }
    if (command === 'save_file') {
      const path = typeof commandArgs.path === 'string' ? commandArgs.path : state.documentPath.value
      if (!path) throw new Error('Missing "path" in args for an unsaved document')
      const saved = await savePath(path)
      return withTarget({ ok: true, result: { saved: true, path: saved } })
    }
    if (command === 'selection') {
      return withTarget({ ok: true, result: [...editor.state.selectedIds].map(id => {
        const node = editor.graph.getNode(id)
        return node ? { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height } : null
      }).filter(Boolean) }, requestedPage)
    }
    if (command === 'export_jsx') {
      const nodeIds = Array.isArray(commandArgs.nodeIds)
        ? commandArgs.nodeIds.filter((id): id is string => typeof id === 'string')
        : editor.graph.getNode(requestedPage)?.childIds ?? []
      const style = commandArgs.style === 'tailwind' ? 'tailwind' : 'openpencil'
      const jsx = nodeIds.length === 1
        ? sceneNodeToJSX(nodeIds[0], editor.graph, style)
        : selectionToJSX(nodeIds, editor.graph, style)
      return withTarget({ ok: true, result: { jsx } }, requestedPage)
    }
    if (command === 'export') {
      const nodeIds = Array.isArray(commandArgs.nodeIds)
        ? commandArgs.nodeIds.filter((id): id is string => typeof id === 'string')
        : [...editor.state.selectedIds]
      if (nodeIds.length === 0) throw new Error('No nodes to export')
      const renderer = editor.renderer
      if (!renderer) throw new Error('Canvas renderer is not ready')
      const format = (typeof commandArgs.format === 'string' ? commandArgs.format.toUpperCase() : 'PNG') as RasterExportFormat
      const data = renderNodesToImage(await getCanvasKit(), renderer, editor.graph, requestedPage, nodeIds, {
        scale: typeof commandArgs.scale === 'number' ? commandArgs.scale : 1,
        format,
      })
      if (!data) throw new Error('Export failed')
      return withTarget({ ok: true, result: { base64: bytesToBase64(data), mimeType: `image/${format.toLowerCase()}` } }, requestedPage)
    }
    if (command === 'tool') {
      const name = typeof commandArgs.name === 'string' ? commandArgs.name : ''
      const toolArgs = isRecord(commandArgs.args) ? commandArgs.args : {}
      if (!name) throw new Error('Missing "name" in args')
      if (name === 'render' && toolArgs.tree) {
        const result = await renderTreeNode(editor.graph, toolArgs.tree as Parameters<typeof renderTreeNode>[1], {
          parentId: typeof toolArgs.parent_id === 'string' ? toolArgs.parent_id : requestedPage,
          x: typeof toolArgs.x === 'number' ? toolArgs.x : undefined,
          y: typeof toolArgs.y === 'number' ? toolArgs.y : undefined,
        })
        computeAllLayouts(editor.graph, requestedPage)
        editor.requestRender()
        return withTarget({ ok: true, result: { id: result.id, name: result.name, type: result.type, children: result.childIds } }, requestedPage)
      }
      const definition = ALL_TOOLS.find(tool => tool.name === name)
      if (!definition) throw new Error(`Unknown tool: ${name}`)
      const figma = makeFigma(requestedPage)
      const result = await definition.execute(figma, toolArgs)
      if (definition.mutates) {
        computeAllLayouts(editor.graph, requestedPage)
        editor.requestRender()
      }
      return withTarget({ ok: true, result }, requestedPage)
    }
    return withTarget({ ok: true, result: executeRPCCommand(editor.graph, command, commandArgs) }, requestedPage)
  }

  const connect = (): void => {
    if (stopped) return
    const current = new WebSocket(`ws://127.0.0.1:${bridge.port}`)
    socket = current
    current.onopen = () => {
      state.connected.value = true
      current.send(JSON.stringify({ type: 'register', token: bridge.authToken }))
    }
    current.onmessage = (event) => {
      void (async () => {
        const request = JSON.parse(String(event.data)) as { type?: string; id?: string; command?: string; args?: unknown }
        if (request.type !== 'request' || !request.id || !request.command) return
        try {
          const result = await handleRequest(request.command, request.args)
          current.send(JSON.stringify({ type: 'response', id: request.id, ...(isRecord(result) ? result : { ok: true, result }) }))
        } catch (error) {
          current.send(JSON.stringify({ type: 'response', id: request.id, ok: false, error: errorMessage(error) }))
        }
      })().catch(error => { state.message.value = errorMessage(error) })
    }
    current.onclose = () => {
      if (socket === current) socket = null
      state.connected.value = false
      if (!stopped) reconnectTimer = setTimeout(connect, 1500)
    }
    current.onerror = () => { current.close() }
  }

  connect()
  return {
    disconnect: () => {
      stopped = true
      clearTimeout(reconnectTimer)
      socket?.close(1000)
      socket = null
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function download(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([ownedArrayBuffer(bytes)], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('当前环境不支持复制到剪贴板')
  await navigator.clipboard.writeText(value)
}
