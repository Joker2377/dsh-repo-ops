import assert from 'node:assert/strict'
import test from 'node:test'

import { createGit } from '../lib/git.js'
import { createGithub } from '../lib/github.js'
import { createTools } from '../lib/tools.js'

/**
 * End-to-end wiring: the real createGit, createGithub and createTools over ONE
 * fake runner. A unit test proves a method builds the right argv; this proves
 * the nine tools actually reach those methods, honour the session cwd, and keep
 * the confirm/readOnly gates in front of the subprocess.
 */

const TAB = String.fromCharCode(9)
const CWD = 'C:/repo'
const SHA = 'a'.repeat(40)
const exec = { agent: { session: { header: { cwd: CWD } } } }

function harness(extra = {}, settings = {}) {
	const calls = []
	const table = { ...defaults(), ...extra }
	const keys = Object.keys(table).sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length)
	const run = async (file, args, options = {}) => {
		const argv = args[0] === '-c' ? args.slice(3) : args
		const match = keys.find(candidate => candidate.split(' ').every((part, index) => argv[index] === part))
		calls.push({ file, argv, cwd: options?.cwd })
		if (match === undefined) return { ok: false, code: 1, stdout: '', stderr: 'no fixture: ' + file + ' ' + argv.join(' '), command: file + ' ' + argv.join(' ') }
		const hit = table[match]
		if (typeof hit === 'function') return hit({ file, argv })
		if (hit !== null && typeof hit === 'object' && 'ok' in hit) return { ok: true, code: 0, stdout: '', stderr: '', ...hit }
		return { ok: true, code: 0, stdout: typeof hit === 'string' ? hit : JSON.stringify(hit), stderr: '', command: file + ' ' + argv.join(' ') }
	}
	const git = createGit({ run, env: {} })
	const github = createGithub({ run, git, settings: { host: 'github.com', watchTimeoutMs: 300000, ...settings } })
	const byName = new Map(createTools({ git, github, settings }).map(tool => [tool.name, tool]))
	const call = (toolName, args, context = exec) => byName.get(toolName).execute(args ?? {}, context)
	const touched = file => calls.filter(call2 => call2.file === file).map(call2 => call2.argv.join(' '))
	return { calls, byName, call, touched }
}

const PR = {
	number: 12, title: 'Add login', state: 'OPEN', url: 'https://github.com/octo/hello/pull/12',
	headRefName: 'feat/x', baseRefName: 'main', isDraft: false, reviewDecision: 'APPROVED',
	mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }],
	comments: [], files: [],
}

const RUNS = [{ databaseId: '9001', displayTitle: 'test', headSha: 'abc1234', status: 'completed', conclusion: 'failure', createdAt: '2026-11-06T02:00:00Z', event: 'push', url: 'https://github.com/octo/hello/actions/runs/9001' }]

function defaults() {
	return {
		// git
		'rev-parse --show-toplevel': CWD + '\ntrue\n.git\nfalse',
		'symbolic-ref --short': 'feat/x' + '\n',
		'remote -v': 'origin' + TAB + 'git@github.com:octo/hello.git (fetch)' + '\n',
		'show --no-patch': 'abc1234' + TAB + SHA + TAB + 'Ann' + TAB + '2026-11-06' + TAB + 'add login' + '\n',
		'rev-parse --abbrev-ref': 'feat/x' + '\n',
		'rev-parse --short': 'abc1234' + '\n',
		'status --porcelain=v2': ['# branch.oid abc1234', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -0', '1 M. N... 100644 100644 100644 ' + SHA + ' ' + SHA + ' lib/a.ts', '? lib/new.ts'].join('\n'),
		'status --porcelain': '',
		'diff --cached': options => (options.argv.includes('--quiet') ? { ok: false, code: 1, stderr: '' } : 'lib/a.ts' + '\n'),
		'diff --numstat': '3' + TAB + '1' + TAB + 'lib/a.ts' + '\n',
		'diff --no-color': 'diff --git a/lib/a.ts b/lib/a.ts' + '\n',
		'ls-files --others': '',
		'log --format': 'abc1234' + TAB + SHA + TAB + 'Ann' + TAB + '2026-11-06' + TAB + 'add login' + '\n',
		add: '',
		commit: { ok: true, stdout: '[feat/x 9999abc] add login' },
		push: { ok: true, stderr: 'To github.com:octo/hello.git' + '\n' + '   1111111..2222222  feat/x -> feat/x' + '\n' },
		fetch: '',
		merge: '',
		reset: '',
		branch: '',
		switch: '',
		tag: '',
		// gh
		'auth status': 'github.com Logged in to github.com account joker (OAuth token)\n',
		'pr list': [PR],
		'pr view': PR,
		'run list': RUNS,
		'run view': { databaseId: '9001', displayTitle: 'test', conclusion: 'failure', jobs: [{ databaseId: '77', name: 'test', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
		'issue list': [{ number: 5, title: 'Bug', state: 'OPEN', url: 'https://github.com/octo/hello/issues/5', labels: [{ name: 'bug' }], authors: [{ login: 'octocat' }] }],
		'issue view': { number: 5, title: 'Bug', state: 'OPEN', url: 'u', body: 'body', author: { login: 'octocat' }, labels: [{ name: 'bug' }], comments: [] },
		'release list': [{ tagName: 'v0.1.0', name: 'v0.1.0', isDraft: false, isPrerelease: false, url: 'u', publishedAt: '2026-11-06T00:00:00Z', assets: [] }],
		'repo view': { nameWithOwner: 'octo/hello', defaultBranchRef: { name: 'main' }, isPrivate: false, parent: null },
	}
}

test('repo_status 把 git 與 GitHub 兩側拼成一頁', async () => {
	const { call, touched } = harness()
	const text = await call('repo_status', {})
	assert.match(text, /feat\/x/)
	assert.match(text, /add login/)
	assert.match(text, /12/, 'PR 編號要出现在摘要裡：' + text.slice(0, 400))
	assert.ok(touched('git').length > 0 && touched('gh').length > 0)
	assert.ok(touched('gh').some(line => line.startsWith('pr list')), touched('gh').join(' | '))
})

test('repo_status 在沒有遠端時不打 gh，只留一條說明', async () => {
	const { call, touched } = harness({ 'remote -v': '' })
	const text = await call('repo_status', {})
	assert.equal(touched('gh').length, 0, touched('gh').join(' | '))
	assert.match(text, /feat\/x/)
})

test('repo_status 用 exec 的 session cwd，明確 path 優先', async () => {
	const a = harness()
	await a.call('repo_status', {})
	assert.ok(a.calls.every(entry => entry.cwd === CWD || entry.cwd === undefined), a.calls.map(entry => entry.cwd).join(' | '))
	const b = harness()
	await b.call('repo_status', { path: 'D:/other/repo' })
	assert.ok(b.calls.some(entry => entry.cwd === 'D:/other/repo'))
})

test('repo_status 缺 cwd 時不呼叫任何命令', async () => {
	const { calls, call } = harness()
	const text = await call('repo_status', {}, {})
	assert.match(text, /失敗/)
	assert.equal(calls.length, 0)
})

test('repo_diff 列檔案數字，要 patch 才抓內容', async () => {
	const stat = harness()
	const text = await stat.call('repo_diff', {})
	assert.match(text, /lib\/a\.ts/)
	assert.equal(stat.touched('git').filter(line => line.startsWith('diff --no-color')).length, 0)
	const full = harness()
	const body = await full.call('repo_diff', { action: 'patch' })
	assert.match(body, /diff --git/)
})

test('repo_commit 先 stage 再 commit，順序在 argv 裡看得见', async () => {
	const { call, touched } = harness()
	const text = await call('repo_commit', { message: 'feat: login', paths: ['lib/a.ts'] })
	assert.match(text, /add login|feat: login|9999abc/, text.slice(0, 300))
	const gitLines = touched('git')
	assert.ok(gitLines.some(line => line.startsWith('add ')))
	assert.ok(gitLines.some(line => line.startsWith('commit ')))
	assert.ok(gitLines.findIndex(line => line.startsWith('add ')) < gitLines.findIndex(line => line.startsWith('commit ')))
})

test('唯讀模式擋下寫入，且不碰任何子程序', async () => {
	const { call, calls } = harness({}, { readOnly: true })
	const text = await call('repo_commit', { message: 'feat: login', paths: ['lib/a.ts'] })
	assert.match(text, /唯讀/)
	assert.equal(calls.length, 0)
	const pushed = await call('repo_push', {})
	assert.match(pushed, /唯讀/)
	assert.equal(calls.length, 0)
})

test('repo_commit 的 undo 需要 confirm', async () => {
	const { call, touched } = harness()
	const text = await call('repo_commit', { action: 'undo' })
	assert.match(text, /confirm/i)
	assert.equal(touched('git').filter(line => line.startsWith('reset')).length, 0)
})

test('repo_push 的裸 force 先回報要跑什麼', async () => {
	const { call, touched } = harness()
	const text = await call('repo_push', { force: true })
	assert.match(text, /forceWithLease|confirm/i)
	assert.equal(touched('git').filter(line => line.startsWith('push')).length, 0)
	const safe = await call('repo_push', { forceWithLease: true, confirm: true })
	assert.match(safe, /feat\/x/)
})

test('repo_pr 的 merge 沒 confirm 不打 gh', async () => {
	const { call, touched } = harness()
	const text = await call('repo_pr', { action: 'merge', number: 12 })
	assert.match(text, /confirm/i)
	assert.equal(touched('gh').filter(line => line.startsWith('pr merge')).length, 0)
	const merged = await call('repo_pr', { action: 'merge', number: 12, confirm: true, strategy: 'squash' })
	assert.match(merged, /12/, merged.slice(0, 300))
	assert.ok(touched('gh').some(line => line.startsWith('pr merge') && line.includes('--squash')), touched('gh').join(' | '))
})

test('repo_pr 讀動作把 repo 換成 --repo 旗標', async () => {
	const { call, touched } = harness()
	const text = await call('repo_pr', { action: 'list' })
	assert.match(text, /Add login/)
	assert.ok(touched('gh').some(line => line.includes('--repo') && line.includes('octo/hello')), touched('gh').join(' | '))
})

test('repo_ci status 列出 run 與失敗 job', async () => {
	const { call, touched } = harness()
	const text = await call('repo_ci', {})
	assert.match(text, /test/)
	assert.ok(touched('gh').some(line => line.startsWith('run list') && line.includes('--branch')), touched('gh').join(' | '))
})

test('repo_ci rerun 需要 confirm；workflow 列表是讀作', async () => {
	const { call, touched } = harness({ 'workflow list': [{ id: '1', name: 'test', state: 'active' }] })
	const text = await call('repo_ci', { action: 'rerun', runId: 9001 })
	assert.match(text, /confirm/i)
	assert.equal(touched('gh').filter(line => line.startsWith('run rerun')).length, 0)
	const listed = await call('repo_ci', { action: 'workflow' })
	assert.match(listed, /test/)
})

test('repo_ci view 收 list 給的字串 run id', async () => {
	const { call, touched } = harness()
	const text = await call('repo_ci', { action: 'view', runId: '9001' })
	assert.match(text, /9001/, text)
	assert.ok(touched('gh').some(line => line.startsWith('run view')), touched('gh').join(' | '))
})

test('repo_release tags 讀本地 git，並說明看到的是哪個目錄', async () => {
	const { call, touched } = harness({ 'for-each-ref': 'v0.1.0' + TAB + 'abc1234' + TAB + '2026-11-06' + TAB + 'first' + '\n' })
	const text = await call('repo_release', { action: 'tags', repo: 'octo/hello' })
	assert.match(text, /v0\.1\.0/, text)
	assert.match(text, /本地 tag/, text)
	assert.equal(touched('gh').filter(line => line.startsWith('api') || line.startsWith('release')).length, 0)
})

test('repo_issue create 走 gh issue create 並帶標題', async () => {
	const { call, touched } = harness({ 'issue create': { url: 'https://github.com/octo/hello/issues/6' } })
	const text = await call('repo_issue', { action: 'create', title: 'Bug', body: 'detail' })
	assert.match(text, /issues\/6|建立/, text.slice(0, 300))
	const line = touched('gh').find(entry => entry.startsWith('issue create'))
	assert.ok(line !== undefined && line.includes('--title'), touched('gh').join(' | '))
})

test('repo_release list 顯示 tag', async () => {
	const { call } = harness()
	const text = await call('repo_release', { action: 'list' })
	assert.match(text, /v0\.1\.0/)
	assert.match(text, /gh release list 不帶附檔/, '沒拿到 assets 就要說清楚：' + text)
})

test('repo_release view 走 release view，並列出附檔', async () => {
	const { call, touched } = harness({
		'release view': { tagName: 'v0.1.0', name: 'v0.1.0', isLatest: true, url: 'https://github.com/octo/hello/releases/tag/v0.1.0', body: 'notes', assets: [{ name: 'pkg.tgz', size: 2048, url: 'https://x/pkg.tgz' }] },
	})
	const text = await call('repo_release', { action: 'view', tag: 'v0.1.0' })
	assert.match(text, /pkg\.tgz/, text)
	assert.match(text, /2 KB/, text)
	assert.ok(touched('gh').some(entry => entry.startsWith('release view')), touched('gh').join(' | '))
})

test('九個工具都收得到 exec 的 cwd 且不會自己 cd', async () => {
	const { call, calls } = harness({ 'branch list': '' })
	await call('repo_branch', { action: 'list' })
	await call('repo_ci', { action: 'list' })
	await call('repo_issue', { action: 'list' })
	await call('repo_release', { action: 'list' })
	assert.ok(calls.every(entry => entry.cwd === CWD || entry.cwd === undefined), calls.map(entry => String(entry.cwd)).join(' | '))
})
