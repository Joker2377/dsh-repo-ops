#!/usr/bin/env node
// Real-CLI smoke run: builds a throwaway repository under .smoke/ and drives the
// tools through real git (no network, no GitHub writes). Read-only gh calls are
// optional and skipped when gh is absent or unauthenticated.
// Run: node scripts/smoke.mjs [path-to-an-existing-repo]
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRunner } from '../lib/cli.js'
import { createGit } from '../lib/git.js'
import { createGithub } from '../lib/github.js'
import { createTools } from '../lib/tools.js'

// The bundle's own runner does the setup calls too, so a sandbox that forbids
// pipes exercises the same fallback the tools will use in production.
const runner = createRunner({ env: process.env })
const run = async (file, args, cwd) => {
	const result = await runner.run(file, args, { cwd })
	return { code: result.code, stdout: result.stdout ?? '', stderr: result.error ?? '', ok: result.ok === true }
}

const log = (label, text) => console.log('\n===== ' + label + ' =====\n' + String(text).trimEnd())

const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'repo-ops-smoke-'))
const exec = { agent: { session: { header: { cwd: root } } } }
const git = createGit({ run: runner.run, env: process.env })
const github = createGithub({ run: runner.run, git, settings: {} })
const byName = new Map(createTools({ git, github, settings: {} }).map(tool => [tool.name, tool]))

if (process.argv[2] === undefined) {
	await mkdir(join(root, 'lib'), { recursive: true })
	await writeFile(join(root, 'README.md'), '# smoke\n', 'utf8')
	await writeFile(join(root, 'lib', 'a.js'), 'export const a = 1\n', 'utf8')
	for (const args of [['init', '-b', 'main'], ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', 'add', '.'], ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial']]) {
		const result = await run('git', args, root)
		if (result.ok !== true) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr)
	}
	await writeFile(join(root, 'lib', 'a.js'), 'export const a = 2\nexport const b = 3\n', 'utf8')
	await writeFile(join(root, 'note.txt'), 'untracked\n', 'utf8')
}

log('repo', root)
log('repo_status', await byName.get('repo_status').execute({}, exec))
log('repo_diff files', await byName.get('repo_diff').execute({ action: 'files' }, exec))
log('repo_diff patch', await byName.get('repo_diff').execute({ action: 'patch', maxChars: 900 }, exec))
log('repo_diff log', await byName.get('repo_diff').execute({ action: 'log' }, exec))
log('repo_branch list', await byName.get('repo_branch').execute({ action: 'list' }, exec))
log('repo_commit undo without confirm', await byName.get('repo_commit').execute({ action: 'undo' }, exec))
log('repo_commit', await byName.get('repo_commit').execute({ paths: ['lib/a.js'], message: 'feat: bump a, add b' }, exec))
log('repo_diff after commit (working tree is clean now)', await byName.get('repo_diff').execute({ action: 'files' }, exec))
log('repo_status after commit', await byName.get('repo_status').execute({}, exec))
log('repo_push dry-run (no remote, expect a clean failure)', await byName.get('repo_push').execute({ dryRun: true }, exec))

// Read-only only: every call here is one gh answers without writing anything.
if (process.env.SMOKE_ONLINE === '1') {
	const repo = process.env.SMOKE_REPO ?? 'Joker2377/dsh-plugin-updates'
	const tag = process.env.SMOKE_TAG ?? 'v0.1.0'
	log('status + auth', await byName.get('repo_status').execute({ repo, include: ['auth', 'repo'] }, exec))
	log('pr list (read-only)', await byName.get('repo_pr').execute({ action: 'list', repo }, exec))
	log('ci list (read-only)', await byName.get('repo_ci').execute({ action: 'list', repo, limit: 5 }, exec))
	const runs = await github.ciList({ repo, limit: 1 })
	if (runs.ok === true && runs.runs.length > 0) log('ci view (read-only)', await byName.get('repo_ci').execute({ action: 'view', repo, runId: runs.runs[0].id }, exec))
	log('issue list (read-only)', await byName.get('repo_issue').execute({ action: 'list', repo }, exec))
	log('release list (read-only)', await byName.get('repo_release').execute({ action: 'list', repo }, exec))
	log('release view (read-only)', await byName.get('repo_release').execute({ action: 'view', repo, tag }, exec))
	log('release tags (read-only)', await byName.get('repo_release').execute({ action: 'tags', repo }, exec))
}

if (process.argv[2] === undefined) await rm(root, { recursive: true, force: true })
console.log('\nsmoke done')
