import assert from 'node:assert/strict'
import test from 'node:test'

import { createGit } from '../lib/git.js'

const TAB = String.fromCharCode(9)
const ROOT = 'C:/repo'
const PATH = { path: ROOT }

/**
 * A git that answers from a table whose keys are argv prefixes (after the
 * standard prefix). A call no fixture covers comes back as a failure, which is
 * what makes the "did it run an extra subprocess" assertions mean something.
 */
function fakeGit(extra = {}) {
	const calls = []
	const table = { ...defaults(), ...extra }
	const keys = Object.keys(table).sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length)
	const run = async (file, args, options) => {
		const argv = args.slice(3)
		assert.equal(args[0], '-c', 'git 一定要帶 core.quotepath=false')
		assert.equal(args[1], 'core.quotepath=false')
		assert.equal(args[2], '--no-pager', '不能讓 git 進入分頁')
		const match = keys.find(candidate => candidate.split(' ').every((part, index) => argv[index] === part))
		calls.push({ argv, key: match ?? argv.join(' '), cwd: options?.cwd })
		const hit = match === undefined ? undefined : table[match]
		if (hit === undefined) return { ok: false, code: 129, stdout: '', stderr: 'no fixture: git ' + argv.join(' '), command: 'git ' + argv.join(' ') }
		const value = typeof hit === 'function' ? hit(argv) : hit
		if (typeof value === 'string') return { ok: true, code: 0, stdout: value, stderr: '', command: 'git ' + argv.join(' ') }
		return { ok: value?.ok ?? true, code: value?.code ?? 0, stdout: value?.stdout ?? '', stderr: value?.stderr ?? '', command: 'git ' + argv.join(' ') }
	}
	return { run, calls }
}

const defaults = () => ({
	'rev-parse --show-toplevel': ROOT + '\ntrue\n.git\nfalse',
	'symbolic-ref --short': 'main' + '\n',
	'remote -v': 'origin' + TAB + 'git@github.com:octo/hello.git (fetch)' + '\n' + 'origin' + TAB + 'git@github.com:octo/hello.git (push)' + '\n',
	'show --no-patch': 'abc1234' + TAB + 'a'.repeat(40) + TAB + 'Ann' + TAB + '2026-11-06' + TAB + 'initial' + '\n',
	'rev-parse --abbrev-ref': 'main' + '\n',
	'rev-parse --short': 'abc1234' + '\n',
	'rev-list --left-right': '1' + TAB + '2' + '\n',
	'diff --cached': argv => (argv.includes('--quiet') ? { ok: false, code: 1, stderr: '' } : 'lib/a.js' + '\n'),
	'ls-files --others': '',
	'status --porcelain': '',
	'status --porcelain=v2': [
		'# branch.oid abc1234',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +1 -2',
		'1 .M N... 100644 100644 100644 ' + 'b'.repeat(40) + ' ' + 'c'.repeat(40) + ' lib/a.js',
		'? note.txt',
	].join('\n'),
	// Write commands the tests are not looking at succeed quietly.
	add: '',
	commit: { ok: true, stdout: '[main abc9999] wip' },
	reset: '',
	merge: '',
	push: '',
	pull: '',
	fetch: '',
	branch: '',
	switch: '',
	tag: '',
	'stash push': '',
	'stash pop': '',
	'stash apply': '',
	'stash drop': '',
	'merge-base --is-ancestor': { ok: true },
	'diff --numstat': '',
	'diff --no-color': '',
})

test('resolveRepo 沒有 path 或不在 repo 裡時給可行動的錯誤', async () => {
	const git = createGit({ run: fakeGit().run })
	assert.match((await git.resolveRepo({})).error, /工作目錄/)
	const outside = createGit({ run: fakeGit({ 'rev-parse --show-toplevel': { ok: false, code: 128, stderr: 'fatal: not a git repository' } }).run })
	const result = await outside.resolveRepo(PATH)
	assert.equal(result.ok, false)
	assert.match(result.error, /不是 git repo/)
})

test('status 讀 porcelain v2 的標頭，不再多跑一次 rev-list', async () => {
	const { run, calls } = fakeGit()
	const git = createGit({ run })
	const status = await git.status(PATH)
	assert.equal(status.ok, true)
	assert.equal(status.branch, 'main')
	assert.equal(status.upstream.name, 'origin/main')
	assert.equal(status.ahead, 1)
	assert.equal(status.behind, 2)
	assert.equal(status.flavour, 'v2')
	assert.equal(status.remoteUrl, 'git@github.com:octo/hello.git')
	assert.equal(status.head.short, 'abc1234')
	assert.deepEqual(status.files.map(file => [file.xy, file.path]), [['.M', 'lib/a.js'], ['??', 'note.txt']])
	assert.ok(!calls.some(call => call.argv[0] === 'rev-list'), '不該有多餘的比較呼叫')
	assert.deepEqual([status.stagedCount, status.untrackedCount, status.clean], [1, 1, false])
	assert.equal(calls.filter(call => call.key === 'rev-list --left-right').length, 0, '標頭裡就有 ahead/behind，不該再問一次')
})

test('status 在沒有 upstream 時給第一次推的提示', async () => {
	const { run } = fakeGit({
		'status --porcelain=v2': '# branch.oid abc1234' + '\n' + '# branch.head main' + '\n',
		'rev-parse --abbrev-ref': { ok: false, code: 128, stderr: 'fatal: no upstream configured' },
	})
	const status = await createGit({ run }).status(PATH)
	assert.equal(status.upstream, null)
	assert.match(status.hint, /setUpstream:true/)
})

test('status 對分離 HEAD 不假裝在 main', async () => {
	const { run } = fakeGit({
		'status --porcelain=v2': '# branch.oid abc1234' + '\n' + '# branch.head (detached)' + '\n',
		'symbolic-ref --short': { ok: false, code: 1, stderr: '' },
	})
	const status = await createGit({ run }).status(PATH)
	assert.equal(status.branch, null)
	assert.equal(status.detached, true)
})

test('status 對老 git 退回 porcelain v1', async () => {
	const { run, calls } = fakeGit({
		'status --porcelain=v2': { ok: false, code: 129, stderr: 'error: unknown option porcelain=v2' },
		'status --porcelain': '.M lib/a.js' + '\n' + 'R  old.js -> new.js' + '\n',
	})
	const status = await createGit({ run }).status(PATH)
	assert.equal(status.flavour, 'v1')
	assert.deepEqual(status.files.map(file => file.path), ['lib/a.js', 'new.js'])
	assert.equal(status.files[1].original, 'old.js')
	assert.ok(calls.some(call => call.key === 'status --porcelain'))
})

test('log 只取叫得到的那些 commit，並帶 author 與 range', async () => {
	const { run, calls } = fakeGit({
		log: 'a1' + TAB + 'a'.repeat(40) + TAB + 'Ann' + TAB + '2026-11-05' + TAB + 'feat: x' + '\n' + 'b2' + TAB + 'b'.repeat(40) + TAB + 'Bob' + TAB + '2026-11-04' + TAB + 'fix: y' + '\n',
	})
	const git = createGit({ run })
	const result = await git.log({ ...PATH, limit: 2, ref: 'main', base: 'origin/main', author: 'Ann' })
	assert.equal(result.commits.length, 2)
	assert.equal(result.commits[0].subject, 'feat: x')
	assert.equal(result.ref, 'origin/main...main')
	const argv = calls.find(call => call.argv[0] === 'log').argv
	assert.ok(argv.includes('-n') && argv.includes('2'))
	assert.ok(argv.includes('--author=Ann'))
	assert.equal(argv[argv.length - 1], 'origin/main...main')
})

test('log 的 limit 被夾在 1 到 500', async () => {
	const { run, calls } = fakeGit({ log: '' })
	await createGit({ run }).log({ ...PATH, limit: 99999 })
	const argv = calls.find(call => call.argv[0] === 'log').argv
	assert.ok(argv.includes('500'), argv.join(' '))
})

test('show 給 commit、檔案與修剪過的 patch', async () => {
	const { run } = fakeGit({
		'diff --numstat': '2' + TAB + '1' + TAB + 'lib/a.js' + '\n',
		'show --no-color': 'commit abc1234' + '\n' + 'diff --git a/lib/a.js b/lib/a.js' + '\n',
	})
	const result = await createGit({ run }).show({ ...PATH, ref: 'abc1234', maxChars: 5000 })
	assert.equal(result.commits[0].short, 'abc1234')
	assert.deepEqual(result.files, [{ path: 'lib/a.js', additions: 2, deletions: 1, status: 'modified' }])
	assert.match(result.patch, /diff --git/)
})

test('diff 預設只列數字，statOnly:false 才抓 patch', async () => {
	const listed = fakeGit({ 'diff --numstat': '-' + TAB + '-' + TAB + 'img/x.png' + '\n' })
	const a = await createGit({ run: listed.run }).diff(PATH)
	assert.equal(a.range, 'working tree vs HEAD')
	assert.deepEqual(a.files, [{ path: 'img/x.png', additions: 0, deletions: 0, status: 'binary' }])
	assert.equal(listed.calls.filter(call => call.argv[0] === 'diff').length, 1, '只要清單時不該再跑一次 diff')

	const full = fakeGit({ 'diff --numstat': '0' + TAB + '3' + TAB + 'gone.js' + '\n', 'diff --no-color': 'diff --git a/gone.js b/gone.js' + '\n' })
	const b = await createGit({ run: full.run }).diff({ ...PATH, staged: true, statOnly: false })
	assert.equal(b.range, 'staged')
	assert.equal(b.files[0].status, 'deleted')
	assert.ok(full.calls.find(call => call.argv.includes('--no-color')).argv.includes('--cached'))
})

test('stage 只加呼叫者點名的檔案，不會自己 -A', async () => {
	const { run, calls } = fakeGit()
	const git = createGit({ run })
	const added = await git.stage({ ...PATH, paths: ['lib/a.js'] })
	assert.deepEqual(added.added, ['lib/a.js'])
	const argv = calls.find(call => call.argv[0] === 'add').argv
	assert.deepEqual(argv, ['add', '--', 'lib/a.js'])
	assert.equal(calls.some(call => call.argv.includes('-A')), false, '不該出現 git add -A')
	const all = await git.stage({ ...PATH, all: true })
	assert.ok(all.note.includes('全部變更'))
})

test('stage 沒給 paths 時沿用暫存區並說明', async () => {
	const { run } = fakeGit()
	const result = await createGit({ run }).stage(PATH)
	assert.deepEqual(result.added, ['lib/a.js'])
	assert.match(result.note, /沿用已 stage/)
})

test('commit 需要先 stage 有東西，否則回報 nothingToCommit 而不是空 commit', async () => {
	const { run } = fakeGit({ 'diff --cached': { ok: true, code: 0, stdout: '' } })
	const result = await createGit({ run }).commit({ ...PATH, message: 'feat: x' })
	assert.equal(result.ok, false)
	assert.equal(result.nothingToCommit, true)
	assert.match(result.error, /暫存區是空的/)
})

test('commit 把 message 與 body 合成一段，並保留 hook 的訊息', async () => {
	const { run, calls } = fakeGit({ commit: argv => ({ ok: true, stdout: '[main abc9999] feat: x' }) })
	const git = createGit({ run })
	const done = await git.commit({ ...PATH, message: 'feat: x', body: 'why', paths: ['lib/a.js'] })
	assert.equal(done.ok, true)
	assert.equal(done.short, 'abc1234')
	const argv = calls.find(call => call.argv[0] === 'commit').argv
	assert.deepEqual(argv, ['commit', '-m', 'feat: x' + '\n\n' + 'why'])
	assert.equal(argv.includes('--no-verify'), false, '絕不能跳過 repo 自己的 hook')

	const hooked = createGit({ run: fakeGit({ commit: { ok: false, code: 1, stderr: 'pre-commit hook failed' } }).run })
	const blocked = await hooked.commit({ ...PATH, message: 'x', paths: ['a'] })
	assert.match(blocked.error, /hook/)
})

test('commit --amend 不需要 message 也不能加 --no-verify', async () => {
	const { run, calls } = fakeGit()
	const result = await createGit({ run }).commit({ ...PATH, amend: true })
	assert.equal(result.ok, true)
	const argv = calls.find(call => call.argv[0] === 'commit').argv
	assert.ok(argv.includes('--amend') && argv.includes('--no-edit'))
	assert.equal(argv.includes('--no-verify'), false)
})

test('undo 沒 confirm 時只說會跑什麼', async () => {
	const { run, calls } = fakeGit()
	const git = createGit({ run })
	const blocked = await git.undo(PATH)
	assert.equal(blocked.needsConfirm, true)
	assert.equal(blocked.command, 'git reset --soft HEAD~1')
	assert.match(blocked.error, /abc1234/)
	assert.equal(calls.filter(call => call.argv[0] === 'reset').length, 0)
	const done = await git.undo({ ...PATH, confirm: true })
	assert.equal(done.ok, true)
	assert.deepEqual(calls.find(call => call.argv[0] === 'reset').argv, ['reset', '--soft', 'HEAD~1'])
})

test('push 的三种安全變體與裸 force 的閘門', async () => {
	const lastPush = () => calls.filter(call => call.argv[0] === 'push').at(-1).argv
	const { run, calls } = fakeGit({ push: { ok: true, stdout: '', stderr: 'To github.com:octo/hello.git' + '\n' + '   abc1234..def5678  main -> main' + '\n' } })
	const git = createGit({ run })
	const plain = await git.push(PATH)
	assert.equal(plain.branch, 'main')
	assert.deepEqual(calls.filter(call => call.argv[0] === 'push').at(-1).argv, ['push', 'origin', 'main'])
	const setUp = await git.push({ ...PATH, setUpstream: true })
	assert.ok(lastPush().includes('--set-upstream'), lastPush().join(' '))
	void setUp
	const lease = await git.push({ ...PATH, forceWithLease: true, dryRun: true })
	assert.ok(lastPush().includes('--force-with-lease') && lastPush().includes('--dry-run'), lastPush().join(' '))
	assert.equal(lease.dryRun, true)
	const gated = await git.push({ ...PATH, force: true })
	assert.equal(gated.needsConfirm, true)
	assert.match(gated.error, /forceWithLease/)
	const forced = await git.push({ ...PATH, force: true, confirm: true })
	assert.ok(lastPush().includes('--force') && forced.ok, lastPush().join(' '))
})

test('push 在分離 HEAD 下不亂推', async () => {
	const { run, calls } = fakeGit({ 'symbolic-ref --short': { ok: false, code: 1, stderr: '' } })
	const result = await createGit({ run }).push(PATH)
	assert.match(result.error, /detached HEAD/)
	assert.equal(calls.filter(call => call.argv[0] === 'push').length, 0)
})

test('push 被拒時點出該先 pull', async () => {
	const { run } = fakeGit({ push: { ok: false, code: 1, stderr: '! [rejected] main -> main (non-fast-forward)' } })
	const result = await createGit({ run }).push(PATH)
	assert.match(result.error, /遠端比本地新/)
})

test('fetch 帶 prune；pull 在工作樹髒的時候不動', async () => {
	const clean = fakeGit({ 'fetch --prune': { ok: true, stderr: 'From github.com:octo/hello' }, pull: '' })
	const fetched = await createGit({ run: clean.run }).fetch(PATH)
	assert.equal(fetched.ok, true)
	assert.deepEqual(clean.calls.find(call => call.argv[0] === 'fetch').argv, ['fetch', '--prune', 'origin'])

	const dirty = fakeGit({ 'status --porcelain': ' M lib/a.js' + '\n' })
	const blocked = await createGit({ run: dirty.run }).pull(PATH)
	assert.equal(blocked.ok, false)
	assert.match(blocked.error, /未提交/)
	assert.equal(dirty.calls.filter(call => call.argv[0] === 'pull').length, 0)

	const rebase = fakeGit({ pull: '' })
	await createGit({ run: rebase.run }).pull({ ...PATH, rebase: true })
	assert.deepEqual(rebase.calls.find(call => call.argv[0] === 'pull').argv, ['pull', '--rebase'])
})

test('sync 先 fetch 再等 confirm 才 merge', async () => {
	const { run, calls } = fakeGit()
	const git = createGit({ run })
	const blocked = await git.sync({ ...PATH, base: 'main' })
	assert.equal(blocked.needsConfirm, true)
	assert.equal(blocked.command, 'git merge main')
	assert.ok(calls.some(call => call.argv[0] === 'fetch'))
	assert.equal(calls.filter(call => call.argv[0] === 'merge').length, 0)
	const done = await git.sync({ ...PATH, base: 'main', confirm: true })
	assert.equal(done.ok, true)
	assert.deepEqual(calls.at(-1).argv, ['merge', 'main'])
})

test('branches 列本地與遠端名字並帶前後差距', async () => {
	const { run } = fakeGit({
		'for-each-ref': argv => (argv.some(part => part === 'refs/remotes')
			? 'origin/main' + '\n' + 'origin/old' + '\n' + 'origin/HEAD' + '\n'
			: 'main' + TAB + 'abc1234' + TAB + 'origin/main' + TAB + '[ahead 1, behind 2]' + TAB + 'initial' + '\n' + 'side' + TAB + 'def5678' + TAB + TAB + TAB + 'wip' + '\n'),
	})
	const result = await createGit({ run }).branches(PATH)
	assert.equal(result.current, 'main')
	assert.equal(result.local.length, 2)
	assert.deepEqual([result.local[0].ahead, result.local[0].behind], [1, 2])
	assert.equal(result.local[0].current, true)
	assert.equal(result.local[1].upstream, null)
	assert.deepEqual(result.remote, ['origin/main', 'origin/old'])
})

test('createBranch 只在 checkout:true 時用 switch -c', async () => {
	const { run, calls } = fakeGit()
	const git = createGit({ run })
	await git.createBranch({ ...PATH, name: 'side', base: 'main' })
	assert.deepEqual(calls.at(-1).argv, ['branch', 'side', 'main'])
	await git.createBranch({ ...PATH, name: 'side2', checkout: true })
	assert.deepEqual(calls.at(-1).argv, ['switch', '-c', 'side2'])
	assert.match((await git.createBranch({ ...PATH })).error, /需要 name/)
})

test('deleteBranch：遠端要 confirm，未合併的先擋下來', async () => {
	const { run, calls } = fakeGit({ 'merge-base --is-ancestor': argv => (argv[2] === 'side' ? { ok: false, code: 1, stderr: '' } : { ok: true }) })
	const git = createGit({ run })
	const remote = await git.deleteBranch({ ...PATH, names: ['old'], remote: 'origin' })
	assert.equal(remote.needsConfirm, true)
	assert.match(remote.command, /git push origin :old/)
	assert.equal(calls.filter(call => call.argv[0] === 'push').length, 0)
	const unmerged = await git.deleteBranch({ ...PATH, names: ['side'] })
	assert.equal(unmerged.ok, false)
	assert.match(unmerged.error, /還沒合併/)
	const forceGate = await git.deleteBranch({ ...PATH, names: ['side'], force: true })
	assert.equal(forceGate.needsConfirm, true)
	const forced = await git.deleteBranch({ ...PATH, names: ['side'], force: true, confirm: true })
	assert.deepEqual(calls.at(-1).argv, ['branch', '-D', 'side'])
	assert.equal(forced.ok, true)
	const merged = await git.deleteBranch({ ...PATH, names: ['main'] })
	assert.deepEqual(calls.at(-1).argv, ['branch', '-d', 'main'])
	assert.equal(merged.ok, true)
})

test('tag 有附註時用 -a -m，刪 tag 要 confirm', async () => {
	const { run, calls } = fakeGit({
		'for-each-ref --sort=-creatordate': 'v0.1.0' + TAB + 'abc1234' + TAB + '2026-11-06' + TAB + 'release v0.1.0' + '\n',
	})
	const git = createGit({ run })
	const list = await git.tag({ ...PATH, action: 'list' })
	assert.deepEqual(list.tags, [{ name: 'v0.1.0', sha: 'abc1234', date: '2026-11-06', subject: 'release v0.1.0' }])
	await git.tag({ ...PATH, action: 'create', name: 'v0.2.0', message: 'release' })
	assert.deepEqual(calls.at(-1).argv, ['tag', '-a', 'v0.2.0', '-m', 'release'])
	await git.tag({ ...PATH, action: 'create', name: 'v0.2.1', ref: 'abc1234' })
	assert.deepEqual(calls.at(-1).argv, ['tag', 'v0.2.1', 'abc1234'])
	const gate = await git.tag({ ...PATH, action: 'delete', name: 'v0.2.1' })
	assert.equal(gate.needsConfirm, true)
})

test('tag 帶 pushTo 時建立後再推那一個 tag；推失敗仍算建好', async () => {
	const { run, calls } = fakeGit({ 'push origin v0.2.9': { ok: false, stderr: 'remote: permission denied' } })
	const git = createGit({ run })
	await git.tag({ ...PATH, action: 'create', name: 'v0.2.8', message: 'release' })
	assert.equal(calls.filter(call => call.argv[0] === 'push').length, 0, '沒有 pushTo 就不該推')
	const pushed = await git.tag({ ...PATH, action: 'create', name: 'v0.2.8', message: 'release', pushTo: 'origin' })
	assert.deepEqual(calls.at(-1).argv, ['push', 'origin', 'v0.2.8'])
	assert.equal(pushed.ok, true)
	assert.equal(pushed.pushed.ok, true)
	assert.equal(pushed.pushed.remote, 'origin')
	assert.equal(pushed.pushed.command, 'git push origin v0.2.8')
	const failed = await git.tag({ ...PATH, action: 'create', name: 'v0.2.9', message: 'release', pushTo: 'origin' })
	assert.equal(failed.ok, true)
	assert.equal(failed.pushed.ok, false)
	assert.match(failed.pushed.error, /permission denied/)
	assert.match(failed.pushed.hint, /認証/)
	assert.match(failed.note, /沒推上 origin/)
})

test('stash：列清單、push 帶 -u，drop 需要 confirm', async () => {
	const { run, calls } = fakeGit({ 'stash list': 'stash@{0}: WIP on main: abc1234 initial' + '\n' })
	const git = createGit({ run })
	const list = await git.stash({ ...PATH, action: 'list' })
	assert.equal(list.entries.length, 1)
	await git.stash({ ...PATH, action: 'push', message: 'wip', includeUntracked: true })
	assert.deepEqual(calls.at(-1).argv, ['stash', 'push', '-m', 'wip', '-u'])
	const gate = await git.stash({ ...PATH, action: 'drop' })
	assert.equal(gate.needsConfirm, true)
	assert.equal(calls.filter(call => call.argv.includes('drop')).length, 0)
	const dropped = await git.stash({ ...PATH, action: 'drop', ref: 'stash@{1}', confirm: true })
	assert.equal(dropped.ok, true)
	assert.deepEqual(calls.at(-1).argv, ['stash', 'drop', 'stash@{1}'])
})

test('worktrees 解析 porcelain 清單', async () => {
	const { run } = fakeGit({
		'worktree list --porcelain': 'worktree C:/repo' + '\n' + 'HEAD abc1234567890' + '\n' + 'branch refs/heads/main' + '\n' + '\n' + 'worktree C:/repo-wt' + '\n' + 'HEAD def567890123' + '\n' + 'detached' + '\n' + '\n',
	})
	const result = await createGit({ run }).worktrees(PATH)
	assert.deepEqual(result.worktrees, [
		{ path: 'C:/repo', sha: 'abc1234', branch: 'main' },
		{ path: 'C:/repo-wt', sha: 'def5678', detached: true },
	])
})

test('remoteInfo 一次給 gh 要的 URL 與分支', async () => {
	const { run } = fakeGit()
	const result = await createGit({ run }).remoteInfo(PATH)
	assert.equal(result.ok, true)
	assert.equal(result.root, ROOT)
	assert.equal(result.remoteUrl, 'git@github.com:octo/hello.git')
	assert.equal(result.branch, 'main')
})

test('version 只留版本號', async () => {
	const { run } = fakeGit({ '--version': 'git version 2.51.0.windows.1' })
	assert.equal(await createGit({ run }).version(), '2.51.0')
})

test('git 失敗時把第一行 stderr 當成錯誤並保留 argv', async () => {
	const { run } = fakeGit({ log: { ok: false, code: 128, stderr: 'fatal: ambiguous argument no-such: unknown revision' + '\n' + 'usage: git log' } })
	const result = await createGit({ run }).log({ ...PATH, ref: 'no-such' })
	assert.equal(result.ok, false)
	assert.match(result.error, /^fatal: ambiguous argument/)
	assert.match(result.command, /git/)
})
