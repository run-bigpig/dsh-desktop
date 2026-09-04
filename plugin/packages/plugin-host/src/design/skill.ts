import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

const SKILL_NAME = 'starweave-design'
const SKILL_DESCRIPTION = '使用 StarWeave Design 画布将文字或视觉参考实时生成为结构化界面，并基于当前选区进行自然语言修改、校验和保存。'
const SKILL_WHEN_TO_USE = '当用户要求创建或修改页面、组件、界面视觉稿，或要求参考截图、线框图完成设计时使用；普通代码实现任务不要使用。'
const SKILL_DIRECTORIES = [
  fileURLToPath(new URL('../skills/starweave-design/', import.meta.url)),
  fileURLToPath(new URL('../../skills/starweave-design/', import.meta.url)),
]

export async function registerStarWeaveDesignSkill(ctx: Context): Promise<() => void> {
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
  throw new Error('starweave-design: bundled skill is missing')
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  return end < 0 ? content : content.slice(end + 5)
}
