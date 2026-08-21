export const zh = {
  tab: '插件市场',
  loading: '正在读取插件目录…',
  loadError: '插件目录暂时不可用。',
  retry: '重试',
  search: '搜索插件、发布者或功能',
  empty: '目录中暂无可安装插件。',
  emptySearch: '没有匹配的插件。',
  catalogVerified: '目录签名已验证',
  catalogUnverified: '目录签名未验证',
  install: '安装',
  update: '更新',
  uninstall: '卸载',
  installed: '已安装',
  permissions: '权限',
  noPermissions: '未声明额外权限',
  operationFailed: '插件操作失败。',
} satisfies Record<string, string>

export type MarketplaceLocaleKey = keyof typeof zh

export const en = {
  tab: 'Marketplace',
  loading: 'Loading the plugin catalog…',
  loadError: 'The plugin catalog is temporarily unavailable.',
  retry: 'Retry',
  search: 'Search plugins, publishers, or capabilities',
  empty: 'No installable plugins are listed.',
  emptySearch: 'No matching plugins.',
  catalogVerified: 'Catalog signature verified',
  catalogUnverified: 'Catalog signature not verified',
  install: 'Install',
  update: 'Update',
  uninstall: 'Uninstall',
  installed: 'Installed',
  permissions: 'Permissions',
  noPermissions: 'No additional permissions declared',
  operationFailed: 'The plugin operation failed.',
} satisfies Record<MarketplaceLocaleKey, string>

export const desktopZh = {
  windowControls: '窗口控制',
  minimize: '最小化',
  maximize: '最大化',
  restore: '还原',
  close: '关闭',
} satisfies Record<string, string>

export type DesktopLocaleKey = keyof typeof desktopZh

export const desktopEn = {
  windowControls: 'Window controls',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
} satisfies Record<DesktopLocaleKey, string>

export const mcpZh = {
  tab: 'MCP', loading: '正在读取 MCP 服务器…', error: '暂时无法读取 MCP 服务器。', retry: '重试',
  catalog: 'MCP 服务器', empty: '尚未配置 MCP 服务器。', add: '添加服务器', edit: '编辑', save: '保存',
  cancel: '取消', remove: '删除', removing: '正在删除…', confirmRemove: '确认删除', serverName: '名称',
  enabled: '启用', transport: '传输方式', transportStdio: 'stdio', transportHttp: 'Streamable HTTP',
  command: '命令', args: '参数（每行一项）', env: '环境变量', url: 'URL', headers: '请求头',
  secretHint: '每行一条 KEY=value。编辑时留空会保留已有值，密钥不会回显。',
  compositionHint: '此服务器由 Harness 组合配置管理，请在对应 YAML 中修改。', disabledTag: '已停用',
  unobserved: '未运行', pending: '等待依赖', loadingPhase: '加载中', active: '运行中', failed: '挂载失败',
  unloading: '卸载中', tools: '个工具', invalidKv: '每行必须是 KEY=value。', saveFailed: '保存失败。',
  removeFailed: '删除失败。',
} satisfies Record<string, string>

export type McpLocaleKey = keyof typeof mcpZh

export const mcpEn = {
  tab: 'MCP', loading: 'Reading MCP servers…', error: 'MCP servers are temporarily unavailable.', retry: 'Retry',
  catalog: 'MCP servers', empty: 'No MCP servers are configured.', add: 'Add server', edit: 'Edit', save: 'Save',
  cancel: 'Cancel', remove: 'Delete', removing: 'Deleting…', confirmRemove: 'Confirm delete', serverName: 'Name',
  enabled: 'Enabled', transport: 'Transport', transportStdio: 'stdio', transportHttp: 'Streamable HTTP',
  command: 'Command', args: 'Arguments (one per line)', env: 'Environment variables', url: 'URL', headers: 'Headers',
  secretHint: 'One KEY=value per line. Leave empty while editing to retain stored values; secrets are never shown.',
  compositionHint: 'This server is managed by a Harness composition; edit the corresponding YAML.', disabledTag: 'Disabled',
  unobserved: 'Not running', pending: 'Waiting for dependencies', loadingPhase: 'Loading', active: 'Running',
  failed: 'Mount failed', unloading: 'Unloading', tools: 'tools', invalidKv: 'Each line must be KEY=value.',
  saveFailed: 'Save failed.', removeFailed: 'Delete failed.',
} satisfies Record<McpLocaleKey, string>

export const visionZh = {
  tab: '视觉', loading: '正在读取视觉设置…', error: '暂时无法读取视觉设置。', retry: '重试',
  endpoint: '视觉模型', endpointHint: '使用 OpenAI 兼容的多模态接口。API Key 只保存在本机且不会回显。',
  baseURL: 'Base URL', model: '模型 ID', apiKey: 'API Key', apiKeySet: '已保存密钥', apiKeyMissing: '尚未保存密钥',
  apiKeyHint: '留空表示保留已保存的密钥。', test: '测试连接', testing: '正在测试…', save: '保存', saving: '正在保存…',
  saved: '已保存。', saveFailed: '保存失败。', targets: '为以下模型开启外挂视觉',
  targetsHint: '启用后，聊天图片先由视觉模型描述，再交给文本模型；原生支持图片的模型不会被接管。',
  emptyCatalog: '当前没有可配置的模型渠道。', nativeTag: '原生视觉', wrapTag: '外挂', models: '个模型',
} satisfies Record<string, string>

export type VisionLocaleKey = keyof typeof visionZh

export const visionEn = {
  tab: 'Vision', loading: 'Reading vision settings…', error: 'Vision settings are temporarily unavailable.', retry: 'Retry',
  endpoint: 'Vision model', endpointHint: 'Use an OpenAI-compatible multimodal endpoint. The API key stays local and is never shown.',
  baseURL: 'Base URL', model: 'Model ID', apiKey: 'API key', apiKeySet: 'Key saved', apiKeyMissing: 'No key saved',
  apiKeyHint: 'Leave blank to retain the saved key.', test: 'Test connection', testing: 'Testing…', save: 'Save', saving: 'Saving…',
  saved: 'Saved.', saveFailed: 'Save failed.', targets: 'Enable wrapped vision for these models',
  targetsHint: 'Chat images are described by the vision model before reaching the text model. Native vision models are not intercepted.',
  emptyCatalog: 'No model providers are available.', nativeTag: 'Native vision', wrapTag: 'Wrapped', models: 'models',
} satisfies Record<VisionLocaleKey, string>

export const documentsZh = {
  upload: '上传文件',
  uploading: '正在转换…',
  uploaded: '文档已加入草稿',
  failed: '文档转换失败。',
  tooLarge: '文件超过 20 MB。',
  unsupported: '不支持该文件格式。',
  imageForwardFailed: '无法将图片加入当前草稿。',
  imageOption: '上传图片',
  imageOptionDetail: 'PNG、JPEG、WebP 或 GIF',
  documentOption: '上传文档',
  documentOptionDetail: 'PDF、Office、EPUB、RTF、CSV 或 OpenDocument',
  dropTitle: '松开以上传文件',
  dropDescription: '支持图片与文档；文档单个最大 20 MB',
  dropUnavailable: '当前无法上传文件',
  attachedDocuments: '已附加的文档',
  sentDocuments: '已发送的文档',
  removeDocument: '移除文档 {name}',
} satisfies Record<string, string>

export type DocumentsLocaleKey = keyof typeof documentsZh

export const documentsEn = {
  upload: 'Upload files',
  uploading: 'Converting…',
  uploaded: 'Document added to draft',
  failed: 'Document conversion failed.',
  tooLarge: 'The file exceeds 20 MB.',
  unsupported: 'This file format is not supported.',
  imageForwardFailed: 'The image could not be added to the current draft.',
  imageOption: 'Upload image',
  imageOptionDetail: 'PNG, JPEG, WebP, or GIF',
  documentOption: 'Upload document',
  documentOptionDetail: 'PDF, Office, EPUB, RTF, CSV, or OpenDocument',
  dropTitle: 'Drop to upload files',
  dropDescription: 'Images and documents; documents up to 20 MB each',
  dropUnavailable: 'File upload is currently unavailable',
  attachedDocuments: 'Attached documents',
  sentDocuments: 'Sent documents',
  removeDocument: 'Remove document {name}',
} satisfies Record<DocumentsLocaleKey, string>
