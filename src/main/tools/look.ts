import { stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const MAX_BYTES = 10 * 1024 * 1024

const schema = z.object({
  images: z.array(z.string().min(1)).min(1).max(4),
  question: z.string().min(1).max(2000)
})
type Args = z.infer<typeof schema>

/** What the vision model is told: it reviews, it does not act. */
export function reviewPrompt(question: string, n: number): string {
  return [
    'You are a visual QA reviewer for work an AI agent just built (slides, a web page, a 3D render).',
    `Look at the attached image${n > 1 ? `s (numbered 1 to ${n} in the order they were sent)` : ''} and answer the question about what you can actually SEE.`,
    'Rules: report only REAL defects a viewer would notice (cut-off or unreadable text, overlap, parts that are missing, broken, floating or far out of proportion, large unintended empty areas); do not suggest style or taste changes. Name the exact place of every defect (image number or slide, and the region); say "no problem found" when there is none; never invent what you cannot see; plain text, no tool blocks, at most 200 words.',
    `QUESTION: ${question}`
  ].join('\n')
}

/**
 * Shows pictures to a model that can see (another chat, configured as `vision` in config/agents.json) and brings back its written verdict.
 * It works for every agent, including the ones whose own chat cannot take images.
 */
export function makeLookTool(ask: (images: string[], prompt: string, signal?: AbortSignal) => Promise<string>): ToolDef<Args> {
  return {
    name: 'look',
    description:
      'Show 1-4 image files (png, jpg, webp, gif: e.g. the paths render returned) to a vision model and get its written verdict. One chat message per call: put several slides in ONE call and ask a precise question (overflow, overlap, contrast, empty areas, wrong colours...).',
    argsHint: '{"images": string[] (1-4 paths), "question": string}',
    schema,
    risk: 'read',
    paths: (a) => a.images,
    summary: (a) => `look at ${a.images.join(', ')}`,
    async run({ images, question }, ctx) {
      const abs: string[] = []
      for (const p of images) {
        const f = ctx.resolve(p)
        if (!IMAGE_EXT.test(f)) throw new Error(`${p} is not a png/jpg/webp/gif image`)
        const st = await stat(f).catch(() => undefined)
        if (!st?.isFile()) throw new Error(`${p} does not exist`)
        if (st.size > MAX_BYTES) throw new Error(`${p} is over 10 MB: render it smaller (width)`)
        abs.push(f)
      }
      const reply = (await ask(abs, reviewPrompt(question, abs.length), ctx.signal)).trim()
      return reply ? `Vision verdict:\n${reply}` : 'The vision model gave no answer: try again, or check with other means.'
    }
  }
}
