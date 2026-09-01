import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

const SKILL_NAME = 'openpencil-design'
const SKILL_DESCRIPTION = '使用 StarWeave 内置 OpenPencil Companion 的实时 MCP 工具创建、读取、修改并验证 .op 设计。'
const SKILL_WHEN_TO_USE = '当用户要求用 OpenPencil 新建设计、修改当前画布、检查布局或导出设计时使用；普通代码或网页实现任务不要使用。'
const SKILL_DIRECTORIES = [
  fileURLToPath(new URL('../skills/openpencil-design/', import.meta.url)),
  fileURLToPath(new URL('../../skills/openpencil-design/', import.meta.url)),
]

export async function registerOpenPencilSkill(ctx: Context): Promise<() => void> {
  const directory = await findSkillDirectory()
  const content = stripFrontmatter(await readFile(resolve(directory, 'SKILL.md'), 'utf8'))
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: directory },
    content,
  })
}

async function findSkillDirectory(): Promise<string> {
  for (const directory of SKILL_DIRECTORIES) {
    try {
      await access(resolve(directory, 'SKILL.md'))
      return directory
    } catch {
      continue
    }
  }
  throw new Error('openpencil: bundled skill is missing')
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  return end < 0 ? content : content.slice(end + 5)
}
