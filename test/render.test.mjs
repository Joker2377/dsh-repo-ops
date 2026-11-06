import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmNeeded, failure, renderAction, renderAuth, renderBranches, renderCommit, renderCommits, renderDiff, renderIssueView, renderIssues, renderPrLine, renderPrList, renderPrView, renderPush, renderReleaseView, renderReleases, renderRunView, renderRuns, renderStatus, renderTags, renderWatch } from '../lib/render.js'

test('status 的報告有身份、髒汙計數與 PR 一行', () => {
	const text = renderStatus({
		ok: true, root: 'C:/r', branch: 'feat/x', head: { short: 'abc1234', subject: 'add login' },
		upstream: { name: 'origin/feat/x' }, ahead: 2, behind: 0, defaultBranch: 'main',
		remoteUrl: 'https://github.com/a/b.git',
		files: [{ xy: 'M ', path: 'lib/a.js' }, { xy: '??', path: 'lib/new.js' }],
		stagedCount: 1, unstagedCount: 1, untrackedCount: 1, clean: false,
		pr: { number: 12, title: 'Add login', state: 'OPEN', checks: [{ name: 'test', bucket: 'fail', conclusion: 'failure' }] },
	})
	assert.match(text, /repo: C:\/r/)
	assert.match(text, /branch: feat\/x/)
	assert.match(text, /tracking: \+2\/-0/)
	assert.match(text, /\[FAIL\] test \(failure\)/)
	assert.match(text, /1 staged change/)
}) 

test('沒有 PR 時要講「沒有」，不能留白', () => {
	assert.equal(renderPrLine(null), 'pull request: none for this branch')
	assert.match(renderPrLine({ number: 3, state: 'OPEN' }), /pull request: #3 OPEN/)
}) 

test('髒汙為零時明確說 clean', () => {
	const text = renderStatus({ ok: true, root: 'r', branch: 'main', files: [], clean: true })
	assert.match(text, /working tree: clean/)
}) 

test('檔案太多時列出前 60 個並講剩下幾個', () => {
	const files = Array.from({ length: 75 }, (unused, index) => ({ xy: 'M ', path: 'f' + index + '.js' }))
	const text = renderStatus({ ok: true, root: 'r', branch: 'b', files, clean: false })
	assert.match(text, /另有 15 個檔案未列出/)
}) 

test('diff 的檔名與增刪數', () => {
	const text = renderDiff({ ok: true, files: [{ path: 'a.ts', additions: 12, deletions: 3 }], range: 'origin/main...HEAD' })
	assert.match(text, /range: origin\/main\.\.\.HEAD/)
	assert.match(text, /\+12 -3/)
	assert.match(text, /12 insertions, 3 deletions/)
}) 

test('diff 空結果要寫出來，不是回空字串', () => {
	assert.match(renderDiff({ ok: true, files: [] }), /no changed files/)
}) 

test('patch 超長時被截斷', () => {
	const text = renderDiff({ ok: true, files: [], patch: 'x'.repeat(30000), maxChars: 1000 })
	assert.ok(text.length < 1600, '實際 ' + text.length)
}) 

test('commit 的報告會標出被跳過的 untracked', () => {
	const text = renderCommit({ ok: true, added: ['a.ts'], skippedUntracked: ['b.ts'], short: 'dead012', summary: 'fix: x', command: 'git commit -m "fix: x"' })
	assert.match(text, /staged: a\.ts/)
	assert.match(text, /untracked 未自動加入.*: b\.ts/)
	assert.match(text, /committed: dead012  fix: x/)
}) 

test('沒有任何東西可提交時不報失敗，而是給指令', () => {
	assert.match(renderCommit({ ok: false, nothingToCommit: true }), /nothing to commit/)
}) 

test('confirm 閘門顯示會跑的那一行', () => {
	const text = renderCommit({ ok: false, needsConfirm: true, error: '要 reset --soft 掉一個 commit', command: 'git reset --soft HEAD~1' })
	assert.match(text, /需要明確確認/)
	assert.match(text, /會跑：git reset --soft HEAD~1/)
}) 

test('push 的報告有前後 sha 與 dry-run 標記', () => {
	const text = renderPush({ ok: true, branch: 'main', before: 'aaa', after: 'bbb', output: 'To github.com:a/b.git', dryRun: true })
	assert.match(text, /aaa -> bbb/)
	assert.match(text, /dry-run/)
}) 

test('push 成功但沒有 PR 時提示可以開一個', () => {
	assert.match(renderPush({ ok: true, createdPr: false }), /repo_pr action=create/)
}) 

test('branch 清單標出现在在哪一列', () => {
	const text = renderBranches({ ok: true, local: [{ name: 'main', current: true, ahead: 0, behind: 0, upstream: 'origin/main', subject: 'init' }, { name: 'x', ahead: null, upstream: null }], remote: ['origin/main'] })
	assert.match(text, /^\*\s+main/m)
	assert.match(text, /^\s+x\s/m)
	assert.match(text, /remote branches: origin\/main/)
}) 

test('PR 列表與 view', () => {
	assert.match(renderPrList({ ok: true, prs: [{ number: 1, title: 'A', state: 'OPEN', headRefName: 'a', baseRefName: 'main', isDraft: true }] }), /^\s+1\s+OPEN\s+yes\s+a -> main/m)
	assert.match(renderPrList({ ok: true, prs: [] }), /找不到符合的 pull request/)
	const view = renderPrView({ ok: true, pr: { number: 2, state: 'OPEN', checks: [{ name: 'lint', bucket: 'pass' }] }, body: 'hi', reviewThreads: [{ isResolved: false, comments: [{ author: { login: 'me' }, body: 'use const', path: 'a.ts' }] }] })
	assert.match(view, /1 unresolved review thread/)
	assert.match(view, /me @ a\.ts: use const/)
}) 

test('run 列表的標記', () => {
	const text = renderRuns({ ok: true, runs: [{ databaseId: 9, name: 'test', displayTitle: 'Fix CI', branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', bucket: 'fail', createdAt: '2026-11-06T08:00:00Z' }] })
	assert.match(text, /\[FAIL\]/)
	assert.match(text, /2026-11-06 08:00:00/)
	assert.match(renderRuns({ ok: true, runs: [] }), /找不到 workflow run/)
}) 

test('run view 把失敗的 job 與 step 排前面', () => {
	const text = renderRunView({ ok: true, run: { databaseId: 9, name: 'test', status: 'completed', conclusion: 'failure', jobs: [
		{ name: 'lint', status: 'completed', conclusion: 'success', bucket: 'pass', steps: [{ name: 'npm test', status: 'completed', conclusion: 'success', bucket: 'pass' }] },
		{ name: 'build', status: 'completed', conclusion: 'failure', bucket: 'fail', steps: [{ name: 'compile', status: 'completed', conclusion: 'failure', bucket: 'fail' }] },
	] } })
	assert.ok(text.indexOf('build') < text.indexOf('lint'), '失敗的 job 要排在前面：\n' + text)
	assert.match(text, /repo_ci action=logs/)
}) 

test('watch 的兩種結局', () => {
	assert.match(renderWatch({ ok: true, runId: 1, status: 'completed', conclusion: 'success', waitedMs: 74000 }), /74s/)
	assert.match(renderWatch({ ok: true, runId: 1, status: 'in_progress', waitedMs: 300000, timedOut: true }), /還在跑/)
}) 

test('issue 的列表與單項', () => {
	assert.match(renderIssues({ ok: true, issues: [{ number: 4, title: 'Bug', state: 'OPEN', updatedAt: '2026-11-01T00:00:00Z' }] }), /^\s+4\s+open\s+2026-11-01\s+Bug/m)
	assert.match(renderIssues({ ok: true, issues: [] }), /找不到 issue/)
	const view = renderIssueView({ ok: true, issue: { number: 4, title: 'Bug', state: 'OPEN', body: 'repro…', labels: [{ name: 'bug' }] }, comments: [{ author: { login: 'u' }, createdAt: '2026-11-02T00:00:00Z', body: 'me too' }] })
	assert.match(view, /labels: bug/)
	assert.match(view, /--- u @ 2026-11-02 00:00:00/)
}) 

test('release 與 tag 的列表', () => {
	assert.match(renderTags({ ok: true, tags: [{ name: 'v0.1.0', subject: 'first' }] }), /v0\.1\.0  first/)
	assert.match(renderTags({ ok: true, tags: [] }), /這個 repo 沒有 tag/)
})

test('release list 沒拿到 assets 時不冒充「沒有附檔」', () => {
	const listed = renderReleases({ ok: true, assetsKnown: false, releases: [{ tag: 'v0.1.0', publishedAt: '2026-11-06T00:00:00Z' }] })
	assert.ok(!/assets/.test(listed.split('\n')[0]), 'assets 欄要藏起來: ' + listed)
	assert.match(listed, /gh release list 不帶附檔/)
	assert.match(listed, /action=view tag=<tag>/)
	const view = renderReleaseView({ ok: true, release: { tag: 'v0.1.0', name: 'v0.1.0', publishedAt: '2026-11-06T00:00:00Z', url: 'https://x/rel', body: 'notes', assets: [{ name: 'dsh-repo-ops-0.1.0.tgz', size: 4096, url: 'https://x/a.tgz' }] } })
	assert.match(view, /dsh-repo-ops-0\.1\.0\.tgz/)
	assert.match(view, /4 KB/)
	assert.match(view, /notes/)
	assert.match(renderReleaseView({ ok: true, release: { tag: 'v1', assets: [] } }), /沒有附檔/)
}) 

test('通用的 action 結果與 auth 報告', () => {
	assert.match(renderAction({ ok: true, number: 7, url: 'https://x/7', command: 'gh pr create' }, '建立 PR'), /建立 PR: ok/)
	assert.match(renderAuth({ ok: true, user: 'Joker2377', repo: 'a/b', defaultBranch: 'main', scopes: ['repo'], ghVersion: '2.92.0', gitVersion: '2.51.0' }), /scopes: repo/)
	assert.match(renderAuth({ ok: true, user: 'u', ghVersion: '2.92.0', gitVersion: '2.51.0' }), /gh 2\.92\.0 \/ git 2\.51\.0/)
}) 

test('失敗的輸出以「失敗：」開頭，且一定帶 error', () => {
	for (const render of [renderStatus, renderDiff, renderCommits, renderCommit, renderPush, renderBranches, renderPrList, renderPrView, renderRuns, renderRunView, renderWatch, renderIssues, renderIssueView, renderReleases, renderReleaseView, renderTags, renderAuth]) {
		const text = render({ ok: false, error: '壞了' })
		assert.ok(text.startsWith('失敗：壞了'), render.name + ' => ' + text)
	}
	assert.ok(failure({}).startsWith('失敗：未知失敗'))
	assert.match(confirmNeeded({}), /需要明確確認/)
}) 