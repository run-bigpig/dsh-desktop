import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

const SKILL_NAME = 'thinkingdata-analysis-orchestrator'
const SKILL_DESCRIPTION = '使用数数（ThinkingData）基础查询工具完成事件、漏斗、留存、路径、用户、付费、LTV、只读 SQL 与数据质量分析。'
const SKILL_DIRECTORIES = [
  fileURLToPath(new URL('../skills/thinkingdata-analysis-orchestrator/', import.meta.url)),
  fileURLToPath(new URL('../../skills/thinkingdata-analysis-orchestrator/', import.meta.url)),
]

export async function registerThinkingDataSkill(ctx: Context): Promise<() => void> {
  const directory = await findSkillDirectory()
  const content = stripFrontmatter(await readFile(resolve(directory, 'SKILL.md'), 'utf8'))
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
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
  throw new Error('thinkingdata: bundled skill is missing')
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  return end < 0 ? content : content.slice(end + 5)
}
