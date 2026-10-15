// Copies the ponytail skill from its ORIGINAL repo (not rewritten) into skills/ponytail, pinned to a commit, and checks the licence first.
// Usage: node scripts/import-ponytail.mjs [ref]   (default: the repo's HEAD)
import { mkdirSync, writeFileSync } from 'node:fs'

const repo = 'DietrichGebert/ponytail'
const ref = process.argv[2] ?? 'HEAD'
const get = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'freeagent-import' } })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r
}

const commit = await (await get(`https://api.github.com/repos/${repo}/commits/${ref}`)).json()
const sha = commit.sha
const raw = async (path) => (await get(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`)).text()
const [skill, license] = await Promise.all([raw('skills/ponytail/SKILL.md'), raw('LICENSE')])

if (!/^MIT License/m.test(license)) throw new Error('LICENSE is not MIT any more: stop and read it before importing')
if (!/^name:\s*ponytail\s*$/m.test(skill)) throw new Error('SKILL.md has no "name: ponytail" frontmatter: layout changed')

mkdirSync('skills/ponytail', { recursive: true })
writeFileSync('skills/ponytail/SKILL.md', skill)
writeFileSync('skills/ponytail/LICENSE', license)
writeFileSync(
  'skills/ponytail/SOURCE.json',
  JSON.stringify({ repo: `https://github.com/${repo}`, sha, commitDate: commit.commit.committer.date, license: 'MIT', files: ['skills/ponytail/SKILL.md', 'LICENSE'], importedAt: new Date().toISOString() }, null, 2) + '\n'
)
console.log(`imported ponytail @ ${sha.slice(0, 10)} (${commit.commit.committer.date})`)
