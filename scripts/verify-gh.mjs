#!/usr/bin/env node
// Read-only verification against the real gh CLI: every --json constant in
// lib/github.js is exercised once, once against a busy public repo (PRs and
// issues to read) and once against a repo with releases and CI runs. Nothing
// here writes: create/merge/comment/rerun/release are covered by unit tests on
// argv and confirm gates only, because they would change someone's repository.
//
// Run: node scripts/verify-gh.mjs      (needs gh auth login)
//      GH_VERIFY_BUSY=owner/name GH_VERIFY_OURS=owner/name node scripts/verify-gh.mjs
import { createRunner } from '../lib/cli.js'
import { createGit } from '../lib/git.js'
import { createGithub } from '../lib/github.js'

const runner = createRunner({ env: process.env })
const git = createGit({ run: runner.run, env: process.env })
const github = createGithub({ run: runner.run, git, settings: {} })

const BUSY = { repo: process.env.GH_VERIFY_BUSY ?? 'cli/cli' }
const OURS = { repo: process.env.GH_VERIFY_OURS ?? 'Joker2377/dsh-plugin-updates' }

// Ours first: no argument is required for these, so they work on any repo.
const cases = [
	['authStatus', { ...OURS }],
	['repoInfo', { ...OURS }],
	['ciList', { ...OURS, limit: 2 }],
	['ciStatus', { ...OURS }],
	['releaseList', { ...OURS }],
	['workflowList', { ...OURS }],
	['prList', { ...BUSY, limit: 2 }],
	['issueList', { ...BUSY, limit: 2 }],
]

async function main() {
	// Follow-ups that need an id we only learn at run time.
	const runs = await github.ciList({ ...OURS, limit: 1 })
	if (runs.ok === true && runs.runs.length > 0) cases.push(['ciView', { ...OURS, runId: runs.runs[0].id }])
	const prs = await github.prList({ ...BUSY, limit: 1 })
	if (prs.ok === true && prs.prs.length > 0) {
		const number = prs.prs[0].number
		cases.push(['prView', { ...BUSY, number }])
		cases.push(['prChecks', { ...BUSY, number }])
	}
	const issues = await github.issueList({ ...BUSY, limit: 1 })
	if (issues.ok === true && issues.issues.length > 0) cases.push(['issueView', { ...BUSY, number: issues.issues[0].number }])
	const releases = await github.releaseList({ ...OURS, limit: 1 })
	if (releases.ok === true && releases.releases.length > 0) cases.push(['releaseView', { ...OURS, tag: releases.releases[0].tag }])

	let failed = 0
	for (const [name, args] of cases) {
		const method = github[name]
		if (typeof method !== 'function') { console.log('FAIL  ' + name + '  not exported'); failed++ ; continue }
		const result = await method(args)
		if (result?.ok === true) {
			const keys = Object.keys(result).filter(key => key !== 'ok' && key !== 'command')
			console.log('ok    ' + name + '  ' + keys.join(','))
		} else {
			failed++
			console.log('FAIL  ' + name + '  ' + String(result?.error ?? '?').slice(0, 300))
		}
	}
	console.log('')
	console.log(cases.length - failed + '/' + cases.length + ' read-only gh calls answered')
	if (failed > 0) process.exitCode = 1
}

await main()
