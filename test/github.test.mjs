import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRepoFlag, createGithub, flattenChecks, ISSUE_JSON, mapRelease, mapRun, normaliseCheck, parseRepoSlug, patchFiles, PR_JSON, PR_LIST_JSON, RELEASE_JSON, RELEASE_LIST_JSON, REPO_JSON, RUN_JSON, RUN_VIEW_JSON } from '../lib/github.js'

/** A gh that records argv and answers from a table keyed by the subcommand. */
function fakeGh(table) {
	const calls = []
	const run = async (file, args) => {
		calls.push({ file, args, key: args.slice(0, 2).join(' ') })
		const hit = table[callKey(args)]
		if (hit === undefined) return { ok: false, code: 1, stdout: '', stderr: 'no fixture for ' + callKey(args), command: 'gh ' + args.join(' ') }
		if (typeof hit === 'function') return hit(args)
		// A fixture that already looks like a runner result is passed through; a
		// bare object is the parsed JSON the command would have printed.
		if (hit !== null && typeof hit === 'object' && 'ok' in hit) return { code: 0, stdout: '', stderr: '', ...hit }
		return { ok: true, code: 0, stdout: typeof hit === 'string' ? hit : JSON.stringify(hit), stderr: '', command: 'gh ' + args.join(' ') }
	}
	return { run, calls }
}

const callKey = args => (args[0] + ' ' + args[1]).trim()

const REPO = { repo: 'octo/hello' }

test('parseRepoSlug 吃 slug、URL、ssh 與 object 四種寫法', () => {
	assert.deepEqual(parseRepoSlug('octo/hello'), { owner: 'octo', repo: 'hello' })
	assert.deepEqual(parseRepoSlug('https://github.com/octo/hello'), { owner: 'octo', repo: 'hello' })
	assert.deepEqual(parseRepoSlug('https://github.com/octo/hello.git'), { owner: 'octo', repo: 'hello' })
	assert.deepEqual(parseRepoSlug('git@github.com:octo/hello.git'), { owner: 'octo', repo: 'hello' })
	assert.deepEqual(parseRepoSlug('ssh://git@github.com/octo/hello'), { owner: 'octo', repo: 'hello' })
	assert.deepEqual(parseRepoSlug({ owner: 'octo', repo: 'hello.git' }), { owner: 'octo', repo: 'hello' })
	assert.equal(parseRepoSlug('hello'), null)
	assert.equal(parseRepoSlug(''), null)
	assert.equal(parseRepoSlug(undefined), null)
})

test('buildRepoFlag 優先使用明確 repo，沒有就請呼叫者給', () => {
	assert.deepEqual(buildRepoFlag({ repo: 'octo/hello' }), { ok: true, args: ['--repo', 'octo/hello'], slug: 'octo/hello', source: 'repo' })
	assert.equal(buildRepoFlag({ repo: 'not a slug' }).ok, false)
	assert.equal(buildRepoFlag({}).ok, false)
	assert.deepEqual(buildRepoFlag({ discovered: { owner: 'a', repo: 'b' } }), { ok: true, args: ['--repo', 'a/b'], slug: 'a/b', source: 'remote' })
	assert.deepEqual(buildRepoFlag({ allowCwd: true }), { ok: true, args: [], slug: null, source: 'cwd' })
})

test('normaliseCheck 認得 check run、commit status、check suite 三種形狀', () => {
	assert.deepEqual(normaliseCheck({ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u' }), { name: 'build', state: 'completed', conclusion: 'success', url: 'u' })
	assert.deepEqual(normaliseCheck({ context: 'ci/legal', state: 'success', targetUrl: 't' }), { name: 'ci/legal', state: 'completed', conclusion: 'success', url: 't' })
	assert.deepEqual(normaliseCheck({ context: 'ci/legal', state: 'pending' }), { name: 'ci/legal', state: 'in_progress', conclusion: null, url: null })
	assert.deepEqual(normaliseCheck({ title: 'Checks', workflowName: 'CI', status: 'IN_PROGRESS' }).name, 'Checks')
	assert.deepEqual(normaliseCheck(null), { name: null, state: null, conclusion: null, url: null })
})

test('flattenChecks 桶化並保留名稱', () => {
	const checks = flattenChecks([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'failure' }])
	assert.deepEqual(checks.map(check => [check.name, check.bucket]), [['a', 'pass'], ['b', 'fail']])
})

test('mapRun 把 gh 的欄位換成合約的名字', () => {
	const run = mapRun({ databaseId: 12, name: 'CI', displayTitle: 'fix: x (#3)', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', createdAt: '2026-11-06T09:00:00Z', url: 'u', headSha: 'abc' })
	assert.equal(run.id, '12')
	assert.equal(run.branch, 'main')
	assert.equal(run.bucket, 'pass')
	assert.equal(run.displayTitle, 'fix: x (#3)')
	assert.equal(run.headSha, 'abc')
})

test('mapRelease 保留 draft/prerelease/latest 三個旗標', () => {
	const release = mapRelease({ tagName: 'v0.1.0', name: 'v0.1.0', isDraft: false, isPrerelease: true, isLatest: false, publishedAt: '2026-11-06T09:00:00Z' })
	assert.equal(release.tag, 'v0.1.0')
	assert.equal(release.isPrerelease, true)
})

test('patchFiles 從 unified patch 數出每個檔的增刪', () => {
	const patch = [
		'diff --git a/lib/a.js b/lib/a.js',
		'index 111..222 100644',
		'--- a/lib/a.js',
		'+++ b/lib/a.js',
		'@@ -1 +1,2 @@',
		'-export const a = 1',
		'+export const a = 2',
		'+export const b = 3',
		'diff --git a/lib/c.js b/lib/c.js',
		'new file mode 100644',
		'index 000..333',
		'--- /dev/null',
		'+++ b/lib/c.js',
		'@@ -0,0 +1 @@',
		'+export const c = 1',
	].join('\n')
	assert.deepEqual(patchFiles(patch), [
		{ path: 'lib/a.js', additions: 2, deletions: 1, status: 'modified' },
		{ path: 'lib/c.js', additions: 1, deletions: 0, status: 'added' },
	])
	assert.deepEqual(patchFiles(''), [])
})

test('authStatus 讀出帳號、host 與 scopes', async () => {
	const { run, calls } = fakeGh({
		'auth status': { ok: true, code: 0, stdout: '', stderr: 'github.com\n  Logged in to github.com account octocat (GITHUB_TOKEN)\n  - Active token: ghp_xxxx\n  - Token scopes: gist, read:org, repo, workflow\n', command: 'gh auth status' },
	})
	const github = createGithub({ run })
	const result = await github.authStatus({})
	assert.equal(result.ok, true)
	assert.equal(result.user, 'octocat')
	assert.equal(result.host, 'github.com')
	assert.deepEqual(result.scopes, ['gist', 'read:org', 'repo', 'workflow'])
	assert.equal(result.ghVersion, null)
	assert.deepEqual(calls[0].args, ['auth', 'status'])
})

test('authStatus 未登入時回 NEED_AUTH 而不是丟例外', async () => {
	const { run } = fakeGh({ 'auth status': () => ({ ok: false, code: 1, stdout: '', stderr: 'gh: To use GitHub CLI in this environment, run gh auth login', command: 'gh auth status' }), '--version -v': 'gh version 2.92.0' })
	const github = createGithub({ run })
	const result = await github.authStatus({})
	assert.equal(result.ok, false)
	assert.match(result.error, /gh auth login/)
})

test('repoInfo 的欄位對得上 gh repo view --json', async () => {
	const { run, calls } = fakeGh({ 'repo view': { nameWithOwner: 'octo/hello', defaultBranchRef: { name: 'main' }, url: 'u' } })
	const github = createGithub({ run })
	const result = await github.repoInfo(REPO)
	assert.equal(result.repo, 'octo/hello')
	assert.equal(result.defaultBranch, 'main')
	assert.deepEqual(calls[0].args.slice(0, 2), ['repo', 'view'])
	assert.ok(calls[0].args.includes('--json'))
	assert.ok(calls[0].args[calls[0].args.indexOf('--json') + 1].includes('nameWithOwner'), 'json 欄位要包含 nameWithOwner')
	assert.deepEqual(calls[0].args.slice(2, 3), ['octo/hello'], 'gh repo view 收位置參數，沒有 --repo：' + calls[0].args.join(' '))
	assert.ok(!calls[0].args.includes('--repo'), '--repo 會被 gh 拒絕（unknown flag）')
})

test('prStatus 用 branch 時先查編號再看細節（gh 沒有 pr view --branch）', async () => {
	const { run, calls } = fakeGh({
		'pr list': [{ number: 7 }],
		'pr view': { number: 7, title: 'Fix it', state: 'OPEN', headRefName: 'fix', baseRefName: 'main', statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
	})
	const github = createGithub({ run })
	const result = await github.prStatus({ ...REPO, branch: 'fix' })
	assert.equal(result.ok, true)
	assert.equal(result.pr.number, 7)
	assert.deepEqual(result.pr.checks.map(check => check.bucket), ['pass'])
	assert.deepEqual(calls[0].args.slice(0, 2), ['pr', 'list'])
	assert.ok(calls[0].args.includes('--head') && calls[0].args.includes('fix'), calls[0].args.join(' '))
	assert.ok(calls[0].args.includes('--state') && calls[0].args.includes('all'), '查編號要連已關閉的一起查')
	assert.deepEqual(calls[1].args.slice(0, 2), ['pr', 'view'])
	assert.ok(calls[1].args.includes('7'), calls[1].args.join(' '))
})

test('prStatus 分支沒有 PR 時回 pr:null 而不是錯誤', async () => {
	const { run } = fakeGh({ 'pr list': [] })
	const github = createGithub({ run })
	const result = await github.prStatus({ ...REPO, branch: 'nobody' })
	assert.equal(result.ok, true)
	assert.equal(result.pr, null)
})

test('prList 限制筆數並帶 state', async () => {
	const { run, calls } = fakeGh({ 'pr list': [{ number: 1, title: 'a', state: 'OPEN', headRefName: 'x', baseRefName: 'main' }] })
	const github = createGithub({ run })
	const result = await github.prList({ ...REPO, state: 'merged', limit: 500 })
	assert.equal(result.prs.length, 1)
	assert.ok(calls[0].args.includes('merged'))
	assert.ok(calls[0].args.includes('50'), 'limit 要夾在 gh 可接受的範圍：' + calls[0].args.join(' '))
})

test('prDiff 從 patch 換算每檔增刪並修剪內容', async () => {
	const { run } = fakeGh({ 'pr diff': 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n' })
	const github = createGithub({ run })
	const result = await github.prDiff({ ...REPO, number: 3, maxChars: 5000 })
	assert.equal(result.range, 'PR #3')
	assert.deepEqual(result.files, [{ path: 'x.js', additions: 1, deletions: 1, status: 'modified' }])
	assert.match(result.patch, /\+new/)
})

test('prCreate 從回傳的 URL 取出編號', async () => {
	const { run, calls } = fakeGh({ 'pr create': 'https://github.com/octo/hello/pull/12' })
	const github = createGithub({ run })
	const result = await github.prCreate({ ...REPO, title: 'feat: x', body: 'why', draft: true })
	assert.equal(result.number, 12)
	assert.equal(result.url, 'https://github.com/octo/hello/pull/12')
	assert.ok(calls[0].args.includes('--draft'))
	assert.ok(calls[0].args.includes('feat: x'))
})

test('prMerge 沒給 confirm 時只回報會跑什麼，不碰 gh', async () => {
	const { run, calls } = fakeGh({ 'pr merge': 'ok' })
	const github = createGithub({ run })
	const blocked = await github.prMerge({ ...REPO, number: 4 })
	assert.equal(blocked.ok, false)
	assert.equal(blocked.needsConfirm, true)
	assert.equal(blocked.command, 'gh pr merge --repo octo/hello 4 --squash')
	assert.equal(calls.length, 0)
	const done = await github.prMerge({ ...REPO, number: 4, strategy: 'rebase', confirm: true })
	assert.equal(done.ok, true)
	assert.deepEqual(calls[0].args.slice(0, 2), ['pr', 'merge'])
	assert.ok(calls[0].args.includes('4') && calls[0].args.includes('--rebase'), calls[0].args.join(' '))
})

test('prMerge 的 auto 是排進佇列，不需要 confirm', async () => {
	const { run, calls } = fakeGh({ 'pr merge': 'ok' })
	const github = createGithub({ run })
	const result = await github.prMerge({ ...REPO, number: 9, auto: true })
	assert.equal(result.ok, true)
	assert.ok(calls[0].args.includes('--auto'))
})

test('ciList 帶 branch 與 workflow 過濾器', async () => {
	const { run, calls } = fakeGh({ 'run list': [{ databaseId: 1, name: 'CI', displayTitle: 't', headBranch: 'main', event: 'pull_request', status: 'in_progress', conclusion: null, createdAt: '2026-11-06T09:00:00Z' }] })
	const github = createGithub({ run })
	const result = await github.ciList({ ...REPO, branch: 'main', workflow: 'ci.yml' })
	assert.equal(result.runs[0].bucket, 'pending')
	assert.ok(calls[0].args.includes('--branch') && calls[0].args.includes('main'))
	assert.ok(calls[0].args.includes('--workflow'))
	assert.ok(calls[0].args.includes(RUN_JSON))
})

test('ciStatus 把失敗的 run 列成 failing', async () => {
	const { run } = fakeGh({ 'run list': [{ databaseId: 2, name: 'CI', status: 'completed', conclusion: 'failure', headBranch: 'main', event: 'push' }] })
	const github = createGithub({ run })
	const result = await github.ciStatus({ ...REPO })
	assert.deepEqual(result.failing, [{ runId: '2', name: 'CI', job: null }])
})

test('ciView 展開 jobs 與 steps 並桶化', async () => {
	const { run, calls } = fakeGh({
		'run view': { databaseId: 5, name: 'CI', status: 'completed', conclusion: 'failure', url: 'u', jobs: [{ databaseId: 6, name: 'test (22)', status: 'completed', conclusion: 'failure', steps: [{ name: 'Run tests', status: 'completed', conclusion: 'failure' }, { name: 'Upload', status: 'completed', conclusion: 'skipped' }] }] },
	})
	const github = createGithub({ run })
	const result = await github.ciView({ ...REPO, runId: 5 })
	assert.equal(result.run.databaseId, '5')
	assert.equal(result.run.jobs[0].bucket, 'fail')
	assert.equal(result.run.jobs[0].steps[1].bucket, 'skipped')
	assert.ok(calls[0].args.includes('5'))
})

test('ciLogs 預設只抓失敗 job 的 log', async () => {
	const { run, calls } = fakeGh({
		'run view': args => (args.includes('--log-failed') || args.includes('--log') ? { ok: true, code: 0, stdout: 'a\nb\nc\n', stderr: '', command: 'gh ' + args.join(' ') } : { ok: true, code: 0, stdout: JSON.stringify({ databaseId: 7, name: 'CI', status: 'completed', conclusion: 'failure', jobs: [] }), stderr: '', command: 'gh ' + args.join(' ') }),
	})
	const github = createGithub({ run })
	const result = await github.ciLogs({ ...REPO, runId: 7 })
	assert.equal(result.ok, true)
	assert.ok(calls[0].args.includes('--log-failed'), '第一次就該只抓失敗段落：' + calls[0].args.join(' '))
	assert.equal(result.logs, 'a\nb\nc\n')
})

test('ciRerun 需要 confirm，且預設只重跑失敗 job', async () => {
	const { run, calls } = fakeGh({ 'run rerun': 'ok' })
	const github = createGithub({ run })
	const blocked = await github.ciRerun({ ...REPO, runId: 8 })
	assert.equal(blocked.needsConfirm, true)
	assert.match(blocked.command, /--failed/)
	assert.equal(calls.length, 0)
	const done = await github.ciRerun({ ...REPO, runId: 8, confirm: true })
	assert.equal(done.ok, true)
})

test('ciWatch 輪詢到終端狀態就回報等待時間', async () => {
	let polls = 0
	const { run } = fakeGh({
		'run view': () => {
			polls += 1
			const status = polls < 2 ? 'in_progress' : 'completed'
			return { ok: true, code: 0, stdout: JSON.stringify({ databaseId: 3, name: 'CI', status, conclusion: status === 'completed' ? 'success' : null, url: 'u', jobs: [] }), stderr: '', command: 'gh run view 3' }
		},
	})
	const github = createGithub({ run, settings: { watchIntervalMs: 1 } })
	const result = await github.ciWatch({ ...REPO, runId: 3, timeoutMs: 2000, intervalMs: 1 })
	assert.equal(result.ok, true)
	assert.equal(result.status, 'completed')
	assert.equal(result.conclusion, 'success')
	assert.equal(result.timedOut, undefined)
	assert.equal(polls, 2)
})

test('ciWatch 超過預算就說還在跑，不死等', async () => {
	const { run } = fakeGh({ 'run view': { databaseId: 4, name: 'CI', status: 'queued', conclusion: null, jobs: [] } })
	const github = createGithub({ run })
	const result = await github.ciWatch({ ...REPO, runId: 4, timeoutMs: 0, intervalMs: 1 })
	assert.equal(result.timedOut, true)
	assert.equal(result.status, 'queued')
})

test('issueList 與 issueView 走 gh issue 的欄位', async () => {
	const { run, calls } = fakeGh({
		'issue list': [{ number: 3, title: 'Bug', state: 'OPEN', updatedAt: '2026-11-01T00:00:00Z', labels: [{ name: 'bug' }] }],
		'issue view': { number: 3, title: 'Bug', state: 'OPEN', url: 'u', body: 'body', author: { login: 'octocat' }, labels: [{ name: 'bug' }], comments: [{ author: { login: 'a' }, body: 'me too', createdAt: '2026-11-02T00:00:00Z' }] },
	})
	const github = createGithub({ run })
	const list = await github.issueList({ ...REPO, state: 'closed' })
	assert.equal(list.issues[0].number, 3)
	assert.ok(calls[0].args.includes('closed'))
	const view = await github.issueView({ ...REPO, number: 3 })
	assert.equal(view.issue.labels[0], 'bug')
	assert.equal(view.comments[0].author.login, 'a')
})

test('issueCreate 與 issueComment 需要標題與內容', async () => {
	const { run, calls } = fakeGh({ 'issue create': 'https://github.com/octo/hello/issues/9', 'issue comment': 'https://github.com/octo/hello/issues/9#issuecomment-1' })
	const github = createGithub({ run })
	assert.equal((await github.issueCreate({ ...REPO })).ok, false)
	const created = await github.issueCreate({ ...REPO, title: 'x', body: 'y', labels: ['bug'] })
	assert.equal(created.number, 9)
	assert.ok(calls[0].args.includes('--label') && calls[0].args.includes('bug'))
	const commented = await github.issueComment({ ...REPO, number: 9, body: 'done' })
	assert.equal(commented.ok, true)
})

test('releaseCreate 組出 gh release create 的完整 argv', async () => {
	const { run, calls } = fakeGh({ 'release create': 'https://github.com/octo/hello/releases/tag/v0.1.0' })
	const github = createGithub({ run })
	const result = await github.releaseCreate({ ...REPO, tag: 'v0.1.0', name: 'v0.1.0', body: 'notes', prerelease: true, assets: ['a.tgz'], generateNotes: true })
	assert.equal(result.ok, true)
	assert.equal(result.url, 'https://github.com/octo/hello/releases/tag/v0.1.0')
	const args = calls[0].args
	assert.deepEqual(args.slice(0, 2), ['release', 'create'])
	assert.equal(args[4], 'v0.1.0', 'tag 是位置參數：' + args.join(' '))
	assert.ok(args.includes('--prerelease'))
	assert.equal(args[args.length - 1], 'a.tgz', '附檔是最後的位置')
	assert.ok(!args.includes('--generate-notes'), '已經給了 body 就不該再加 --generate-notes')
})

test('releaseView 與 releaseList 的欄位', async () => {
	const { run } = fakeGh({ 'release view': { tagName: 'v1', name: 'v1', isLatest: true, assets: [{ name: 'x.tgz', size: 10, url: 'u' }] }, 'release list': [{ tagName: 'v1', name: 'v1', isLatest: true }] })
	const github = createGithub({ run })
	const view = await github.releaseView({ ...REPO, tag: 'v1' })
	assert.equal(view.release.tag, 'v1')
	const list = await github.releaseList({ ...REPO })
	assert.equal(list.releases[0].tag, 'v1')
})

test('releaseDelete 需要 confirm 而且用 --yes 才不會卡住', async () => {
	const { run, calls } = fakeGh({ 'release delete': 'ok' })
	const github = createGithub({ run })
	const blocked = await github.releaseDelete({ ...REPO, tag: 'v0.0.9' })
	assert.equal(blocked.needsConfirm, true)
	assert.equal(calls.length, 0)
	const done = await github.releaseDelete({ ...REPO, tag: 'v0.0.9', confirm: true })
	assert.equal(done.ok, true)
	assert.ok(calls[0].args.includes('--yes'))
})

test('repo 推不出來時回報 NEED_REPO 而不亂打 gh', async () => {
	const { run, calls } = fakeGh({})
	const github = createGithub({ run })
	const result = await github.prList({ repo: '??? ??' })
	assert.equal(result.ok, false)
	assert.match(result.error, /請傳 repo/)
	assert.equal(calls.length, 0)
})

test('gh 401 換成「請先 gh auth login」', async () => {
	const { run } = fakeGh({ 'pr list': () => ({ ok: false, code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', command: 'gh pr list' }) })
	const github = createGithub({ run })
	const result = await github.prList(REPO)
	assert.equal(result.ok, false)
	assert.match(result.error, /gh auth login/)
})

test('gh 404 換成找不到 repo 的說明', async () => {
	const { run } = fakeGh({ 'release list': () => ({ ok: false, code: 1, stdout: '', stderr: 'HTTP 404: Not Found', command: 'gh release list' }) })
	const github = createGithub({ run })
	const result = await github.releaseList(REPO)
	assert.match(result.error, /404/)
})

test('--json 欄位一律是扁平名稱：gh 不支援巢狀選欄', () => {
	// 實測 gh 2.92：--json 'assets{name}' / 'jobs{name}' 都會被 Unknown JSON field 拒絕，
	// 所以每個常數都只能是頂層欄位名，欄位內容交給 mapper 收窄。
	for (const [name, value] of Object.entries({ PR_JSON, PR_LIST_JSON, RUN_JSON, RUN_VIEW_JSON, RELEASE_JSON, RELEASE_LIST_JSON, ISSUE_JSON, REPO_JSON })) {
		assert.ok(!/[{}]/.test(value), name + ' 不能帶巢狀選欄: ' + value)
		for (const field of value.split(',')) assert.match(field, /^[A-Za-z][A-Za-z0-9]*$/, name + ' 有不合法欄位: ' + field)
	}
	assert.match(RUN_JSON, /headBranch/)
	assert.match(PR_JSON, /statusCheckRollup/)
	assert.match(RUN_VIEW_JSON, /jobs/)
	assert.match(RELEASE_JSON, /assets/)
})
