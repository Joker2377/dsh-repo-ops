import assert from 'node:assert/strict'
import test from 'node:test'

import { createTools } from '../lib/tools.js'
import { groupThreads } from '../lib/tools.js'

/** 假的 git/github：記錄被怎麼叫，回固定的資料。任何真實程序都不會被 spawn。 */
function fakes(overrides = {}) {
	const calls = []
	const recorder = name => (args = {}) => {
		calls.push({ name, args })
		const custom = overrides[name]
		if (custom !== undefined) return Promise.resolve(typeof custom === 'function' ? custom(args) : custom)
		return Promise.resolve({ ok: true })
	}
	const git = {}
	const github = {}
	for (const name of ['status', 'log', 'show', 'diff', 'stage', 'commit', 'push', 'fetch', 'pull', 'sync', 'branches', 'createBranch', 'switchBranch', 'deleteBranch', 'tag', 'undo', 'resolveRepo']) git[name] = recorder(name)
	for (const name of ['authStatus', 'repoInfo', 'prStatus', 'prList', 'prView', 'prCreate', 'prUpdate', 'prComment', 'prReviewComments', 'prReply', 'prDiff', 'prCheckout', 'prReady', 'prMerge', 'prChecks', 'ciList', 'ciView', 'ciLogs', 'ciWatch', 'ciRerun', 'ciStatus', 'issueList', 'issueView', 'issueCreate', 'issueComment', 'issueSetState', 'releaseList', 'releaseView', 'releaseCreate', 'releaseEdit', 'releaseDelete', 'workflowList', 'workflowRun']) github[name] = recorder(name)
	return { git, github, calls }
}

/** 假的 exec：cwd 從 session 來，不是 process.cwd()。 */
const exec = { agent: { session: { header: { cwd: 'C:/work/project' } } } }

function tools(overrides = {}, settings = {}) {
	const bag = fakes(overrides)
	const byName = new Map(createTools({ git: bag.git, github: bag.github, settings }).map(tool => [tool.name, tool]))
	return { byName, calls: bag.calls }
}

test('repo_status 合併 git 與 GitHub，並把 session 的 cwd 傳下去', async () => {
	const { byName, calls } = tools({
		status: { ok: true, root: 'C:/work/project', branch: 'main', head: { short: 'abc1234', subject: 'x' }, files: [], clean: true },
		prStatus: { ok: true, pr: { number: 7, title: 't', state: 'OPEN', checks: [] } },
	})
	const text = await byName.get('repo_status').execute({}, exec)
	assert.match(text, /branch: main/)
	assert.match(text, /pull request: #7 OPEN/)
	assert.equal(calls.find(call => call.name === 'status').args.cwd, 'C:/work/project')
}) 

test('GitHub 那側壞了不影響 git 的報告，但要寫出原因', async () => {
	const { byName } = tools({
		status: { ok: true, root: 'C:/r', branch: 'main', files: [], clean: true },
		prStatus: { ok: false, error: '未登入，請先跑 gh auth login' },
	})
	const text = await byName.get('repo_status').execute({}, exec)
	assert.match(text, /branch: main/)
	assert.match(text, /GitHub 這側沒回應：未登入/)
}) 

test('path 參數優先於 session 的 cwd', async () => {
	const { byName, calls } = tools({ status: { ok: true, root: 'C:/other', branch: 'x', files: [] } })
	await byName.get('repo_status').execute({ path: 'C:/other/sub' }, exec)
	assert.equal(calls[0].args.path, 'C:/other/sub')
}) 

test('唯讀模式擋下寫入，並且完全不去叫 git', async () => {
	const { byName, calls } = tools({}, { readOnly: true })
	const text = await byName.get('repo_commit').execute({ message: 'nope' }, exec)
	assert.match(text, /唯讀模式/)
	assert.equal(calls.length, 0)
}) 

test('唯讀模式不擋唯讀工具', async () => {
	const { byName, calls } = tools({ branches: { ok: true, local: [] } }, { readOnly: true })
	await byName.get('repo_branch').execute({ action: 'list' }, exec)
	assert.equal(calls.length, 1)
}) 

test('空字串參數不會变成 git 的參數', async () => {
	const { byName, calls } = tools({ commit: { ok: true, short: 'aaa', summary: 'x' } })
	await byName.get('repo_commit').execute({ message: '   ', paths: ['', '  '] }, exec)
	assert.equal(calls[0].args.message, undefined)
	assert.equal(calls[0].args.paths, undefined)
}) 

test('merge 的 confirm 直接送到模組，工具不自己決定', async () => {
	const { byName, calls } = tools({ prMerge: { ok: false, needsConfirm: true, error: '要合併 PR #3', command: 'gh pr merge 3 --squash' } })
	const text = await byName.get('repo_pr').execute({ action: 'merge', number: 3 }, exec)
	assert.equal(calls[0].args.confirm, false)
	assert.match(text, /需要明確確認/)
	assert.match(text, /會跑：gh pr merge 3 --squash/)
}) 

test('action 對應到正確的模組函式與參數', async () => {
	const { byName, calls } = tools()
	await byName.get('repo_pr').execute({ action: 'create', title: 'T', body: 'B', draft: true, repo: 'a/b' }, exec)
	assert.equal(calls[0].name, 'prCreate')
	assert.deepEqual(calls[0].args.title ?? calls[0].args.title, 'T')
	assert.equal(calls[0].args.repo, 'a/b')
	await byName.get('repo_ci').execute({ action: 'watch', runId: 42 }, exec)
	assert.equal(calls[1].name, 'ciWatch')
	assert.equal(calls[1].args.runId, 42)
	await byName.get('repo_issue').execute({ action: 'close', number: 9 }, exec)
	assert.equal(calls[2].name, 'issueSetState')
	assert.equal(calls[2].args.state, 'closed')
	await byName.get('repo_release').execute({ action: 'tags' }, exec)
	assert.equal(calls[3].name, 'tag')
	assert.equal(calls[3].args.action, 'list')
}) 

test('失敗的資料不會被當成成功輸出', async () => {
	const { byName } = tools({ prList: { ok: false, error: '找不到 repo' } })
	const text = await byName.get('repo_pr').execute({ action: 'list' }, exec)
	assert.match(text, /^失敗：找不到 repo/)
}) 

test('review 留言彙成執行緒，未結的排前面', () => {
	const threads = groupThreads([
		{ id: 1, body: 'top', path: 'a.ts', author: 'me', resolved: false },
		{ id: 2, inReplyToId: 1, body: 're', author: 'you' },
		{ id: 3, body: 'other', resolved: true },
	])
	assert.equal(threads.length, 2)
	assert.equal(threads[0].comments.length, 2)
	assert.equal(threads[0].isResolved, false)
	assert.equal(threads[1].isResolved, true)
}) 