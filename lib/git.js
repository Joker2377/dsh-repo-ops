/**
 * The git side of the bundle: everything that works without a GitHub token.
 *
 * Two rules. First, only machine-stable git interfaces are parsed -
 * --porcelain=v2 with a v1 fallback, --format with tab separators,
 * for-each-ref, rev-list --left-right --count. Human-facing columns, colours
 * and progress output are never touched, so a git upgrade cannot silently
 * change what a tool returns. Second, nothing here builds a shell string: every
 * call is an argv array handed to the runner in lib/cli.js, which is why a
 * multi-line commit message or a path with a quote in it cannot break out.
 *
 * Failures are values. Every method resolves to { ok: true, ... } or
 * { ok: false, error } whose text names the next move. Destructive methods
 * (undo, force push, force delete) return { ok: false, needsConfirm: true,
 * command } and run nothing until confirm:true arrives.
 *
 * @module dsh-repo-ops/git
 */

import { clip, firstLine } from './cli.js'
import { parseAheadBehind } from './format.js'

/** Standard prefix: keep non-ASCII paths literal, never page, never rewrite. */
const PREFIX = ['-c', 'core.quotepath=false', '--no-pager']

/** Field separator for --format strings: a tab, which cannot appear in a sha. */
const TAB = String.fromCharCode(9)

/** How a missing repository is reported: an instruction, not a stack trace. */
const NOT_A_REPO = '這個目錄不是 git repo（rev-parse 找不到 .git）。請用 path 傳 repo 內任一目錄的絕對路徑。'

/**
 * @param {{ run: (name: string, args: string[], options?: object) => Promise<object> }} deps
 * @returns {Record<string, (options?: any) => Promise<object>>}
 */
export function createGit(deps) {
	const run = deps.run

	/** One git call with the standard prefix. Never throws, never shells. */
	const git = (cwd, args, options = {}) => run('git', [...PREFIX, ...(Array.isArray(args) ? args : [])], { ...options, ...(cwd === undefined || cwd === null ? {} : { cwd }) })

	/** Collapse a failed run into one readable line, keeping the argv shown. */
	const failed = (result, hint) => ({
		ok: false,
		error: firstLine(result?.stderr) || firstLine(result?.error) || (hint ?? 'git 執行失敗'),
		...(typeof result?.command === 'string' ? { command: result.command } : {}),
	})

	/**
	 * Resolve any path inside a repository to its root, once per call.
	 * @param {{ path?: string, cwd?: string }} options
	 */
	const resolveRepo = async options => {
		const start = options?.path ?? options?.cwd
		if (typeof start !== 'string' || start.trim() === '') return { ok: false, error: '沒有可用的工作目錄：請用 path 傳 repo 內任一目錄的絕對路徑。' }
		const result = await git(start, ['rev-parse', '--show-toplevel', '--is-inside-work-tree', '--git-dir', '--is-bare-repository'])
		if (result.ok !== true) return { ok: false, error: NOT_A_REPO, ...(result.command ? { command: result.command } : {}), ...(result.stderr ? { detail: firstLine(result.stderr) } : {}) }
		const lines = String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
		if (lines.length < 2) return { ok: false, error: NOT_A_REPO }
		return { ok: true, root: lines[0].trim(), insideWorkTree: lines[1].trim() === 'true', bare: lines[3] === 'true' }
	}

	/** Current branch name, or null for a detached HEAD - never defaults to "main". */
	const currentBranch = async root => {
		const result = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
		if (result.ok !== true) return null
		const name = firstLine(result.stdout)
		return name === '' ? null : name
	}

	/** origin's fetch URL, or null when no remote is configured. */
	const remoteUrl = async root => {
		const result = await git(root, ['remote', '-v'])
		if (result.ok !== true) return null
		for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
			const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
			if (match !== null && match[1] === 'origin') return match[2]
		}
		return null
	}

	/** The repository's default branch as far as git knows; null if unknown. */
	const defaultBranch = async root => {
		const head = await git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
		if (head.ok === true) {
			const name = firstLine(head.stdout).replace(/^origin\//, '')
			if (name !== '' && name !== 'HEAD') return name
		}
		// No init.defaultBranch here: that is what git would name a *new* repo,
		// which says nothing about what this repository's default branch is.
		// Unknown stays unknown; repoInfoFromGitHub answers it exactly.
		return null
	}

	/** HEAD as { short, sha, author, date, subject }. */
	const headInfo = async root => {
		const result = await git(root, ['show', '--no-patch', '--format=%h' + TAB + '%H' + TAB + '%an' + TAB + '%ad' + TAB + '%s', '--date=short', 'HEAD'])
		if (result.ok !== true) return { short: null, sha: null, author: null, date: null, subject: null }
		return splitCommit(firstLine(result.stdout))
	}

	/** The upstream branch of a branch, or null. */
	const upstreamOf = async (root, branch) => {
		if (typeof branch !== 'string' || branch === '') return null
		const result = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', branch + '@{upstream}'])
		if (result.ok !== true) return null
		const name = firstLine(result.stdout)
		if (name === '' || name === branch) return null
		return name
	}

	/** ahead/behind against an upstream name; null pair when it cannot be known. */
	const aheadBehind = async (root, upstreamName) => {
		if (typeof upstreamName !== 'string' || upstreamName === '') return { ahead: null, behind: null }
		const result = await git(root, ['rev-list', '--left-right', '--count', upstreamName + '...HEAD'])
		if (result.ok !== true) return { ahead: null, behind: null, error: firstLine(result.stderr) || firstLine(result.error) }
		const parsed = parseAheadBehind(firstLine(result.stdout))
		return parsed === null ? { ahead: null, behind: null } : { ahead: parsed.ahead, behind: parsed.behind }
	}

	/** A one-call snapshot of where the agent is. */
	const status = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const root = repo.root
		const v2 = await git(root, ['status', '--porcelain=v2', '--branch'])
		let parsed = v2.ok === true ? parsePorcelainV2(v2.stdout) : null
		let flavour = 'v2'
		if (parsed === null) {
			const v1 = await git(root, ['status', '--porcelain'])
			if (v1.ok !== true) return failed(v1, 'git status 執行失敗')
			parsed = parsePorcelainV1(v1.stdout)
			flavour = 'v1'
		}
		const branch = parsed.branch ?? (await currentBranch(root))
		const [head, url, fallback] = await Promise.all([headInfo(root), remoteUrl(root), defaultBranch(root)])
		const upstreamName = parsed.upstream ?? (await upstreamOf(root, branch))
		const position = parsed.ahead === null || parsed.ahead === undefined ? await aheadBehind(root, upstreamName) : { ahead: parsed.ahead, behind: parsed.behind }
		const files = parsed.files ?? []
		const data = {
			ok: true,
			root,
			branch,
			detached: branch === null,
			head,
			upstream: upstreamName === null ? null : { name: upstreamName, remote: remotePart(upstreamName), branch: branchPart(upstreamName) },
			ahead: position.ahead,
			behind: position.behind,
			defaultBranch: fallback,
			remoteUrl: url,
			files,
			stagedCount: files.filter(file => file.xy !== '??' && file.xy[0] !== ' ').length,
			unstagedCount: files.filter(file => file.xy !== '??' && file.xy.length > 1 && file.xy[1] !== ' ').length,
			untrackedCount: files.filter(file => file.xy === '??').length,
			clean: files.length === 0,
			flavour,
		}
		if (upstreamName === null && data.detached === false) data.hint = '這個分支沒有 upstream；第一次推請用 repo_push(setUpstream:true)。'
		if (position.error !== undefined) data.notes = ['比對 upstream 失敗：' + position.error]
		return data
	}

	/** Commit list, newest first. ref may be a single commit or a range. */
	const log = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const count = clamp(options?.limit, 1, 500, 20)
		const args = ['log', '--format=%h' + TAB + '%H' + TAB + '%an' + TAB + '%ad' + TAB + '%s', '--date=short', '-n', String(count)]
		if (typeof options?.author === 'string' && options.author !== '') args.push('--author=' + options.author)
		const range = rangeArg(options?.ref, options?.base)
		if (range !== null) args.push(range)
		const paths = cleanPaths(options?.paths)
		if (paths !== null) args.push('--', ...paths)
		const result = await git(repo.root, args)
		if (result.ok !== true) return failed(result, '找不到這個 ref 的 commit')
		return { ok: true, ref: range ?? 'HEAD', commits: parseCommits(result.stdout) }
	}

	/** One commit: its header, the files it touched, and a clipped patch. */
	const show = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const ref = typeof options?.ref === 'string' && options.ref.trim() !== '' ? options.ref.trim() : 'HEAD'
		const meta = await git(repo.root, ['show', '--no-patch', '--format=%h' + TAB + '%H' + TAB + '%an' + TAB + '%ad' + TAB + '%s', '--date=short', ref])
		if (meta.ok !== true) return failed(meta, '找不到 commit：' + ref)
		const files = await numstat(repo.root, [ref + '^', ref], null)
		const patch = await git(repo.root, ['show', '--no-color', '--patch', '--unified=3', ref])
		return {
			ok: true,
			commits: parseCommits(meta.stdout),
			files: files.ok === true ? files.files : [],
			patch: patch.ok === true ? clip(String(patch.stdout ?? ''), options?.maxChars ?? 6000) : '',
		}
	}

	/** What changed: a numstat table, plus the patch itself when asked. */
	const diff = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const paths = cleanPaths(options?.paths)
		const refs = options?.staged === true ? ['--cached'] : options?.base !== undefined ? [rangeArg(options?.ref, options.base) ?? ''] : options?.ref !== undefined && options.ref !== '' ? [String(options.ref)] : []
		const range = options?.staged === true ? 'staged' : refs.length > 0 ? refs[0] : 'working tree vs HEAD'
		const files = await numstat(repo.root, refs, paths)
		if (files.ok !== true) return files
		const data = { ok: true, range, files: files.files }
		if (options?.statOnly === false) {
			const args = ['diff', '--no-color', '--unified=3', ...refs.filter(part => part !== '')]
			if (paths !== null) args.push('--', ...paths)
			const patch = await git(repo.root, args)
			if (patch.ok !== true) return failed(patch, '讀 diff 失敗')
			data.patch = clip(String(patch.stdout ?? ''), options?.maxChars ?? 6000)
		}
		return data
	}

	/** git add without -A: only what the caller listed. */
	const stage = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const paths = cleanPaths(options?.paths)
		if (options?.all === true) {
			const result = await git(repo.root, ['add', '-A'])
			if (result.ok !== true) return failed(result, 'git add -A 失敗')
			return { ok: true, added: await stagedFiles(repo.root), command: result.command, note: '已 stage 全部變更（含 untracked）。' }
		}
		if (paths === null) {
			const staged = await stagedFiles(repo.root)
			return { ok: true, added: staged, note: staged.length > 0 ? '沒有指定 paths：沿用已 stage 的 ' + staged.length + ' 個檔案。' : '沒有指定 paths，暫存區也是空的。' }
		}
		const result = await git(repo.root, ['add', '--', ...paths])
		if (result.ok !== true) return failed(result, 'git add 失敗（路徑不存在或被 .gitignore 排除？）')
		const added = await stagedFiles(repo.root)
		const data = { ok: true, added: paths, command: result.command }
		if (added.length > paths.length) data.note = '暫存區裡另外還有 ' + (added.length - paths.length) + ' 個之前就 stage 過的檔案，會一起提交。'
		return data
	}

	/**
	 * Stage the listed paths and commit them in one call. Never adds anything
	 * the caller did not name; skipped untracked files are reported, not hidden.
	 */
	const commit = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const root = repo.root
		const message = typeof options?.message === 'string' ? options.message.trim() : ''
		const body = typeof options?.body === 'string' ? options.body.trim() : ''
		if (options?.amend !== true && message === '') return { ok: false, error: 'commit 需要 message（第一行主旨）。' }
		const paths = cleanPaths(options?.paths)
		let staged = []
		if (options?.all === true) {
			const result = await git(root, ['add', '-A'])
			if (result.ok !== true) return failed(result, 'git add -A 失敗')
			staged = await stagedFiles(root)
		} else if (paths !== null) {
			const result = await git(root, ['add', '--', ...paths])
			if (result.ok !== true) return failed(result, 'git add 失敗（路徑不存在或被 .gitignore 排除？）')
			staged = paths
		} else {
			staged = await stagedFiles(root)
		}
		const data = { ok: true, added: staged }
		if (options?.all !== true && paths === null) {
			const untracked = await untrackedFiles(root)
			if (untracked.length > 0) data.skippedUntracked = untracked
		}
		const quiet = await git(root, ['diff', '--cached', '--quiet'])
		if (quiet.ok === true && options?.amend !== true && options?.allowEmpty !== true) {
			data.ok = false
			data.nothingToCommit = true
			data.error = '暫存區是空的，沒有東西可提交。要提交檔案請傳 paths，要一起加入 untracked 請給 all:true。'
			return data
		}
		const args = ['commit']
		if (message !== '') args.push('-m', body === '' ? message : message + '\n\n' + body)
		else args.push('--amend', '--no-edit')
		if (options?.amend === true && message !== '') args.push('--amend')
		if (options?.allowEmpty === true) args.push('--allow-empty')
		const result = await git(root, args)
		if (result.ok !== true) {
			const failure = failed(result, 'git commit 失敗')
			if (/pre-commit|commit-msg|hook/i.test(String(result.stderr ?? ''))) failure.error += '（hook 擋下來了；這是 repo 自己的 hook，不是工具的問題）'
			return failure
		}
		const head = await headInfo(root)
		return { ...data, ok: true, short: head.short, sha: head.sha, summary: head.subject, command: result.command }
	}

	/**
	 * Roll one step back without losing work. Refuses to run without confirm,
	 * and the refusal names the exact command it withheld.
	 */
	const undo = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const kind = typeof options?.kind === 'string' ? options.kind : 'commit'
		if (kind !== 'commit') return { ok: false, error: 'undo 目前只支援 kind=commit（soft reset HEAD~1）。' }
		const command = 'git reset --soft HEAD~1'
		if (options?.confirm !== true) {
			const head = await headInfo(repo.root)
			return {
				ok: false,
				needsConfirm: true,
				command,
				error: '這會把 HEAD 往回退一個 commit（' + (head.short ?? '?') + ' ' + (head.subject ?? '') + '），變更會留在暫存區不會不見。確認要退請帶 confirm:true 重呼。',
			}
		}
		const result = await git(repo.root, ['reset', '--soft', 'HEAD~1'])
		if (result.ok !== true) return failed(result, 'reset --soft 失敗（已經是最後面一個 commit？）')
		return { ok: true, command, undone: 'HEAD~1', note: '上一個 commit 已退回暫存區，檔案沒丟。' }
	}

	/** Push the branch, with the safe variants first and a gate on a bare force. */
	const push = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const root = repo.root
		const remote = typeof options?.remote === 'string' && options.remote !== '' ? options.remote : 'origin'
		const branch = typeof options?.branch === 'string' && options.branch !== '' ? options.branch : await currentBranch(root)
		if (branch === null) return { ok: false, error: '目前处在 detached HEAD，沒有分支可推。請先 repo_branch(action=switch) 或帶 branch。' }
		if (options?.force === true && options?.confirm !== true) {
			return { ok: false, needsConfirm: true, command: 'git push --force ' + remote + ' ' + branch, error: '裸 --force 會覆蓋遠端歷史（其他人可能因此丢 commit）。建議改用 forceWithLease:true；堅持要裸 force 請帶 confirm:true。' }
		}
		const args = ['push', remote]
		if (options?.setUpstream === true) args.push('--set-upstream')
		if (options?.forceWithLease === true) args.push('--force-with-lease')
		if (options?.force === true && options?.confirm === true) args.push('--force')
		if (options?.dryRun === true) args.push('--dry-run')
		args.push(branch)
		const before = await shortSha(root, branch)
		const result = await git(root, args)
		if (result.ok !== true) {
			const failure = failed(result, 'git push 失敗')
			const text = String(result.stderr ?? '') + String(result.stdout ?? '')
			if (/signal pipe|win32 error 5|couldn't create/i.test(text)) failure.error += '（這個環境不給 git 建立子程序溝通用的 pipe，push 需要在一般的終端機執行。）'
			else if (/rejected|non-fast-forward|fetch first/i.test(text)) failure.error += '（遠端比本地新：先 repo_branch(action=pull) 或 sync 再推；真的要吃掉遠端請用 forceWithLease。）'
			else if (/could not read Username|Authentication failed|permission denied/i.test(text)) failure.error += '（遠端認証失敗：請在終端機先完成 gh auth 或 git credential 設定。）'
			return failure
		}
		const after = await shortSha(root, branch)
		const output = String(result.stdout ?? '') + String(result.stderr ?? '')
		const data = { ok: true, branch, upstream: remote + '/' + branch, before, after, output, command: result.command }
		if (options?.dryRun === true) data.dryRun = true
		const url = /https?:\/\/[^\s'"]+\/pull\/\d+/.exec(output)
		if (url !== null) data.prUrl = url[0]
		return data
	}

	/** Fetch one remote and prune the branches that disappeared there. */
	const fetch = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const remote = typeof options?.remote === 'string' && options.remote !== '' ? options.remote : 'origin'
		const result = await git(repo.root, ['fetch', '--prune', remote])
		if (result.ok !== true) return failed(result, 'git fetch 失敗（網路或認証？）')
		return { ok: true, command: result.command, note: '已抓取 ' + remote + '（含 prune）。', output: clip(String(result.stderr ?? ''), 800) }
	}

	/** Pull the current branch, merge by default and --rebase on request. */
	const pull = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const dirty = await git(repo.root, ['status', '--porcelain'])
		if (dirty.ok === true && String(dirty.stdout ?? '').trim() !== '') {
			return { ok: false, error: '工作樹有未提交的變更，pull 可能會把它們搞亂。請先 repo_commit 或 stash 再 pull。' }
		}
		const args = ['pull']
		if (options?.rebase === true) args.push('--rebase')
		const remote = typeof options?.remote === 'string' && options.remote !== '' ? options.remote : null
		if (remote !== null) args.push(remote)
		const result = await git(repo.root, args)
		if (result.ok !== true) {
			const failure = failed(result, 'git pull 失敗')
			if (/conflict|CONFLICT/i.test(String(result.stderr ?? '') + String(result.stdout ?? ''))) failure.error += '（有衝突要處理：解決後 git add + git rebase --continue 或 git commit。）'
			return failure
		}
		const head = await headInfo(repo.root)
		return { ok: true, command: result.command, note: '現在 HEAD 是 ' + (head.short ?? '?') + ' ' + (head.subject ?? ''), output: clip(String(result.stdout ?? ''), 800) }
	}

	/** Bring another branch into the current one; the merge itself needs confirm. */
	const sync = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const root = repo.root
		const branch = await currentBranch(root)
		const wanted = typeof options?.base === 'string' && options.base !== '' ? options.base : await defaultBranch(root)
		if (wanted === null) return { ok: false, error: '不知道要接哪個 base：請傳 base，或先設定遠端的預設分支（git remote set-head origin -a）。' }
		const remote = typeof options?.remote === 'string' && options.remote !== '' ? options.remote : 'origin'
		const target = wanted.includes('/') || options?.base !== undefined ? wanted : remote + '/' + wanted
		const fetched = await git(root, ['fetch', '--prune', remote])
		if (fetched.ok !== true) return failed(fetched, '抓不到 ' + remote + '，無法 sync')
		const command = 'git merge ' + target
		if (options?.confirm !== true) {
			return { ok: false, needsConfirm: true, command, error: '要把 ' + target + ' 接進現在的分支' + (branch === null ? '' : '（' + branch + '）') + '，可能會產生 merge commit 或衝突。確認請帶 confirm:true 重呼。' }
		}
		const merged = await git(root, ['merge', target])
		if (merged.ok !== true) {
			const failure = failed(merged, 'merge 失敗')
			if (/CONFLICT/.test(String(merged.stdout ?? '') + String(merged.stderr ?? ''))) failure.error += '（請解決衝突後 git add + git commit）'
			return failure
		}
		return { ok: true, command, note: '已把 ' + target + ' 接進來。', output: clip(String(merged.stdout ?? ''), 800) }
	}

	/** Local branches with position and upstream, plus the remote names. */
	const branches = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const head = await git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
		const current = head.ok === true ? firstLine(head.stdout) : null
		const locals = await git(repo.root, ['for-each-ref', '--format=%(refname:short)' + TAB + '%(objectname:short)' + TAB + '%(upstream:short)' + TAB + '%(upstream:track)' + TAB + '%(subject)', 'refs/heads'])
		if (locals.ok !== true) return failed(locals, '讀分支清單失敗')
		const rems = await git(repo.root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
		const local = String(locals.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
			const cells = line.split(TAB)
			const track = parseTrack(cells[3])
			return { name: cells[0], current: cells[0] === current, upstream: cells[2] === '' ? null : cells[2], ahead: track.ahead, behind: track.behind, subject: cells.slice(4).join(TAB) }
		})
		const remote = rems.ok === true ? String(rems.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '' && !line.endsWith('/HEAD')).map(line => line.trim()) : []
		return { ok: true, current, local, remote }
	}

	const createBranch = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const name = typeof options?.name === 'string' ? options.name.trim() : ''
		if (name === '') return { ok: false, error: 'create branch 需要 name。' }
		const args = options?.checkout === true ? ['switch', '-c', name] : ['branch', name]
		if (typeof options?.base === 'string' && options.base !== '') args.push(options.base.trim())
		const result = await git(repo.root, args)
		if (result.ok !== true) return failed(result, '建立分支失敗（名字已經存在？）')
		return { ok: true, changed: [name], note: options?.checkout === true ? '已建立並切過去。' : '已建立（目前還不在這個分支）。', command: result.command }
	}

	const switchBranch = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const name = typeof options?.name === 'string' ? options.name.trim() : ''
		if (name === '') return { ok: false, error: 'switch branch 需要 name。' }
		const from = await currentBranch(repo.root)
		const result = await git(repo.root, ['switch', name])
		if (result.ok !== true) return failed(result, '切分支失敗（工作樹有未提交的變更會被覆蓋？）')
		return { ok: true, changed: [name], note: (from ?? '(detached)') + ' -> ' + name, command: result.command }
	}

	const deleteBranch = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const names = cleanPaths(options?.names)
		if (names === null) return { ok: false, error: 'delete branch 需要 names（或 name）。' }
		if (options?.remote !== undefined && options?.remote !== null && options.remote !== '') {
			if (options?.confirm !== true) return { ok: false, needsConfirm: true, command: 'git push ' + options.remote + ' ' + names.map(item => ':' + item).join(' '), error: '這會刪掉遠端上的 ' + names.join(', ') + '（别人就看不到了）。確認請帶 confirm:true。' }
			const args = ['push', options.remote, ...names.map(item => ':' + item)]
			const result = await git(repo.root, args)
			if (result.ok !== true) return failed(result, '刪遠端分支失敗')
			return { ok: true, changed: names, command: result.command }
		}
		const unmerged = []
		for (const name of names) {
			const merged = await git(repo.root, ['merge-base', '--is-ancestor', name, 'HEAD'])
			if (merged.ok !== true) unmerged.push(name)
		}
		if (unmerged.length > 0 && options?.force !== true) {
			return { ok: false, error: '這 ' + unmerged.length + ' 個分支還沒合併進現在分支，刪了會掉 commit：' + unmerged.join(', ') + '。確定要刪請給 force:true 與 confirm:true。', changed: names.filter(name => !unmerged.includes(name)) }
		}
		if (options?.force === true && options?.confirm !== true) return { ok: false, needsConfirm: true, command: 'git branch -D ' + names.join(' '), error: '要用 -D 強制刪掉未合併的分支 ' + names.join(', ') + '。確認請帶 confirm:true。' }
		const args = ['branch', options?.force === true ? '-D' : '-d', ...names]
		const result = await git(repo.root, args)
		if (result.ok !== true) return failed(result, '刪分支失敗（分支還在被 worktree 使用？）')
		return { ok: true, changed: names, command: result.command }
	}

	/** Tags: list them, or make one. Deleting a tag goes through the gate. */
	const tag = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const action = typeof options?.action === 'string' ? options.action : 'list'
		if (action === 'list') {
			const result = await git(repo.root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)' + TAB + '%(objectname:short)' + TAB + '%(creatordate:short)' + TAB + '%(subject)', 'refs/tags'])
			if (result.ok !== true) return failed(result, '讀 tag 清單失敗')
			const tags = String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
				const cells = line.split(TAB)
				return { name: cells[0], sha: cells[1], date: cells[2], subject: cells.slice(3).join(TAB) }
			})
			return { ok: true, tags }
		}
		const name = typeof options?.name === 'string' ? options.name.trim() : ''
		if (name === '') return { ok: false, error: 'tag 需要 name。' }
		if (action === 'delete') {
			if (options?.confirm !== true) return { ok: false, needsConfirm: true, command: 'git tag -d ' + name, error: '要刪掉本地 tag ' + name + '。確認請帶 confirm:true（遠端的 tag 請用 repo_release action=delete）。' }
			const result = await git(repo.root, ['tag', '-d', name])
			if (result.ok !== true) return failed(result, '刪 tag 失敗')
			return { ok: true, changed: [name], command: result.command }
		}
		const args = ['tag']
		const message = typeof options?.message === 'string' ? options.message.trim() : ''
		if (message !== '') args.push('-a', name, '-m', message)
		else args.push(name)
		if (typeof options?.ref === 'string' && options.ref !== '') args.push(options.ref.trim())
		const result = await git(repo.root, args)
		if (result.ok !== true) return failed(result, 'tag 建立失敗（名字已經存在？）')
		const data = { ok: true, changed: [name], note: message === '' ? '輕量 tag（沒有附註）。' : '附註 tag 已建立。', command: result.command }
		const remote = typeof options?.pushTo === 'string' ? options.pushTo.trim() : ''
		if (remote === '') return data
		const pushed = await git(repo.root, ['push', remote, name])
		data.pushed = pushed.ok === true
			? { remote, ok: true, command: pushed.command, output: clip(String(pushed.stdout ?? '') + String(pushed.stderr ?? ''), 400) }
			: { remote, ok: false, error: firstLine(pushed.stderr) || firstLine(pushed.error) || 'git push ' + remote + ' ' + name + ' 失敗', command: pushed.command }
		if (data.pushed.ok !== true) {
			const text = String(pushed.stderr ?? '') + String(pushed.stdout ?? '')
			if (/signal pipe|win32 error 5|couldn't create/i.test(text)) data.pushed.hint = '這個環境不給 git 建立子程序用的 pipe，推 tag 需要在一般終端機執行。'
			else if (/could not read Username|Authentication failed|permission denied/i.test(text)) data.pushed.hint = '遠端認証失敗：先在終端機完成 gh auth 或 git credential 設定。'
			data.note += ' tag 已建立在本地，但沒推上 ' + remote + '。'
		}
		return data
	}

	/** Stash: list, push, or pop the top entry. Nothing is dropped silently. */
	const stash = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const action = typeof options?.action === 'string' ? options.action : 'list'
		if (action === 'list') {
			const result = await git(repo.root, ['stash', 'list'])
			if (result.ok !== true) return failed(result, '讀 stash 清單失敗')
			const entries = String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
			return { ok: true, entries, note: entries.length === 0 ? '沒有 stash。' : undefined }
		}
		const args = action === 'pop' ? ['stash', 'pop'] : action === 'apply' ? ['stash', 'apply'] : action === 'clear' ? ['stash', 'clear'] : action === 'drop' ? ['stash', 'drop'] : ['stash', 'push']
		if (action === 'push' && typeof options?.message === 'string' && options.message !== '') args.push('-m', options.message)
		if (action === 'push' && options?.includeUntracked === true) args.push('-u')
		if (action === 'drop' || action === 'clear') {
			if (options?.confirm !== true) return { ok: false, needsConfirm: true, command: 'git stash ' + action + (typeof options?.ref === 'string' ? ' ' + options.ref : ''), error: 'stash ' + action + ' 會永久丟掉暫存的變更。確認請帶 confirm:true。' }
			if (action === 'drop') args.push(typeof options?.ref === 'string' && options.ref !== '' ? options.ref : 'stash@{0}')
		}
		const result = await git(repo.root, args)
		if (result.ok !== true) return failed(result, 'stash ' + action + ' 失敗')
		return { ok: true, command: result.command, output: clip(String(result.stdout ?? '') + String(result.stderr ?? ''), 600) }
	}

	/** Worktrees, read-only: which checkouts exist and where. */
	const worktrees = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const result = await git(repo.root, ['worktree', 'list', '--porcelain'])
		if (result.ok !== true) return failed(result, '讀 worktree 清單失敗')
		const list = []
		let entry = null
		for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
			if (line.startsWith('worktree ')) {
				if (entry !== null) list.push(entry)
				entry = { path: line.slice('worktree '.length).trim() }
			} else if (line.startsWith('HEAD ') && entry !== null) entry.sha = line.slice(5).trim().slice(0, 7)
			else if (line.startsWith('branch ') && entry !== null) entry.branch = line.slice('branch refs/heads/'.length).trim()
			else if (line === 'detached' && entry !== null) entry.detached = true
		}
		if (entry !== null) list.push(entry)
		return { ok: true, worktrees: list }
	}

	/** Remote URL and current branch in one cheap call - what gh needs to find owner/repo. */
	const remoteInfo = async options => {
		const repo = await resolveRepo(options)
		if (repo.ok !== true) return repo
		const [url, branch] = await Promise.all([remoteUrl(repo.root), currentBranch(repo.root)])
		return { ok: true, root: repo.root, remoteUrl: url, branch }
	}

	/** The git version string, for the auth report. */
	const version = async () => {
		const result = await git(undefined, ['--version'])
		if (result.ok !== true) return null
		return /(\d+\.\d+\.\d+)/.exec(firstLine(result.stdout))?.[1] ?? null
	}

	/** The files currently staged. */
	const stagedFiles = async root => {
		const result = await git(root, ['diff', '--cached', '--name-only'])
		if (result.ok !== true) return []
		return String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
	}

	const untrackedFiles = async root => {
		const result = await git(root, ['ls-files', '--others', '--exclude-standard'])
		if (result.ok !== true) return []
		return String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() !== '').slice(0, 40)
	}

	/** numstat rows, rename-aware, as { path, additions, deletions, status }. */
	const numstat = async (root, refs, paths) => {
		const args = ['diff', '--numstat', ...refs.filter(part => typeof part === 'string' && part !== '')]
		if (paths !== null) args.push('--', ...paths)
		const result = await git(root, args)
		if (result.ok !== true) return failed(result, '讀 diff 數字失敗')
		const files = []
		for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
			if (line.trim() === '') continue
			const cells = line.split('\t')
			if (cells.length < 3) continue
			const [additions, deletions, target] = cells
			const binary = additions === '-' || deletions === '-'
			const renamed = /=>/.test(target)
			files.push({
				path: renamed ? renameTarget(target) : target,
				additions: binary ? 0 : Number(additions),
				deletions: binary ? 0 : Number(deletions),
				status: binary ? 'binary' : renamed ? 'renamed' : additions === '0' ? 'deleted' : deletions === '0' ? 'added' : 'modified',
			})
		}
		return { ok: true, files }
	}

	const shortSha = async (root, rev) => {
		const result = await git(root, ['rev-parse', '--short', rev])
		return result.ok === true ? firstLine(result.stdout) : null
	}

	return { resolveRepo, remoteInfo, version, status, log, show, diff, stage, commit, undo, push, fetch, pull, sync, branches, createBranch, switchBranch, deleteBranch, tag, stash, worktrees }
}

/**
 * git status --porcelain=v2 --branch. The only part of status that git
 * promises to keep stable; unknown line kinds are skipped, not guessed at.
 *
 * @param {string} stdout
 * @returns {{ branch: string | null, upstream: string | null, files: { xy: string, path: string, original?: string }[] } | null}
 */
function parsePorcelainV2(stdout) {
	const text = String(stdout ?? '')
	// --branch always prints the headers; without them this is not v2 output.
	if (!/^# branch\./m.test(text)) return null
	const branch = { branch: null, upstream: null, ahead: null, behind: null, files: [] }
	for (const line of text.split(/\r?\n/)) {
		if (line === '') continue
		if (line.startsWith('# branch.head ')) {
			const name = line.slice('# branch.head '.length).trim()
			branch.branch = name === '' || name === '(detached)' ? null : name
			continue
		}
		if (line.startsWith('# branch.upstream ')) {
			branch.upstream = line.slice('# branch.upstream '.length).trim()
			continue
		}
		if (line.startsWith('# branch.ab ')) {
			const cells = line.slice('# branch.ab '.length).trim().split(/\s+/)
			branch.ahead = Number.parseInt(cells[0]?.replace('+', '') ?? '', 10)
			branch.behind = Number.parseInt(cells[1]?.replace('-', '') ?? '', 10)
			if (!Number.isFinite(branch.ahead)) branch.ahead = null
			if (!Number.isFinite(branch.behind)) branch.behind = null
			continue
		}
		if (line.startsWith('# branch.oid ') || line.startsWith('# untracked') || line.startsWith('# ignored')) continue
		const kind = line[0]
		if (kind === '?') {
			branch.files.push({ xy: '??', path: line.slice(2) })
			continue
		}
		if (kind === '1' || kind === '2' || kind === 'u') {
			const cells = line.slice(2).split(' ')
			const xy = cells[0] ?? '  '
			const pathPart = kind === '2' ? cells.slice(8).join(' ') : cells.slice(7).join(' ')
			if (kind === 'u') {
				branch.files.push({ xy: 'UU', path: pathPart, conflict: true })
				continue
			}
			// A rename is "new<TAB>old" in v2 (and "old -> new" in v1); both spellings
			// are handled so a rename never looks like one mystery path.
			const tabSplit = pathPart.indexOf(TAB)
			const arrow = pathPart.indexOf(' -> ')
			if (tabSplit !== -1) branch.files.push({ xy, path: pathPart.slice(0, tabSplit), original: pathPart.slice(tabSplit + 1) })
			else if (arrow !== -1) branch.files.push({ xy, path: pathPart.slice(arrow + 4), original: pathPart.slice(0, arrow) })
			else branch.files.push({ xy, path: pathPart })
			continue
		}
		// Anything newer than v2 as we know it is left out rather than guessed.
	}
	return branch
}

/**
 * git status --porcelain (v1) for git older than 2.11.
 *
 * @param {string} stdout
 * @returns {{ branch: null, upstream: null, files: { xy: string, path: string, original?: string }[] }}
 */
function parsePorcelainV1(stdout) {
	const files = []
	for (const line of String(stdout ?? '').split(/\r?\n/)) {
		if (line.trim() === '') continue
		const xy = line.slice(0, 2)
		const pathPart = line.slice(3)
		const arrow = pathPart.indexOf(' -> ')
		if (arrow === -1) files.push({ xy, path: pathPart })
		else files.push({ xy, path: pathPart.slice(arrow + 4), original: pathPart.slice(0, arrow) })
	}
	return { branch: null, upstream: null, files }
}

/**
 * --format=%h%x09%H%x09%an%x09%ad%x09%s rows.
 *
 * @param {string} stdout
 * @returns {{ short: string, sha: string, author: string, date: string, subject: string }[]}
 */
function parseCommits(stdout) {
	const tab = String.fromCharCode(9)
	const rows = []
	for (const line of String(stdout ?? '').split(/\r?\n/)) {
		if (line.trim() === '') continue
		const cells = line.split(tab)
		rows.push({ short: cells[0] ?? '', sha: cells[1] ?? '', author: cells[2] ?? '', date: cells[3] ?? '', subject: cells.slice(4).join(tab) })
	}
	return rows
}

/** One commit row in the same column order as parseCommits. */
function splitCommit(line) {
	const tab = String.fromCharCode(9)
	const cells = String(line ?? '').split(tab)
	return { short: cells[0] ?? null, sha: cells[1] ?? null, author: cells[2] ?? null, date: cells[3] ?? null, subject: cells.slice(4).join(tab) }
}

/** %(upstream:track) reads "[ahead 2, behind 1]" or is empty. */
function parseTrack(text) {
	const value = String(text ?? '').trim()
	if (value === '') return { ahead: null, behind: null }
	const ahead = /ahead (\d+)/.exec(value)
	const behind = /behind (\d+)/.exec(value)
	return { ahead: ahead === null ? 0 : Number(ahead[1]), behind: behind === null ? 0 : Number(behind[1]) }
}

/** origin/x -> origin. */
function remotePart(name) {
	const slash = String(name ?? '').indexOf('/')
	return slash === -1 ? null : name.slice(0, slash)
}

/** origin/x -> x. */
function branchPart(name) {
	const slash = String(name ?? '').indexOf('/')
	return slash === -1 ? name ?? null : name.slice(slash + 1)
}

/** A git rename path may use braces: lib/{old => new}.js. */
function renameTarget(pathPart) {
	const value = String(pathPart ?? '')
	const brace = /\{([^}]*)\}/.exec(value)
	if (brace !== null) {
		const inner = brace[1].split(' => ')
		return value.replace(brace[0], (inner[1] ?? '').trim())
	}
	const arrow = value.split(' => ')
	return arrow.length > 1 ? arrow[arrow.length - 1] : value
}

/** Number from the model, kept inside the range that git handles well. */
function clamp(value, min, max, fallback) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** A range string for git, or null when the caller gave nothing. */
function rangeArg(ref, base) {
	const head = typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : 'HEAD'
	if (typeof base === 'string' && base.trim() !== '') return base.trim() + '...' + head
	if (typeof ref === 'string' && ref.trim() !== '') return ref.trim()
	return null
}

/** A list of paths, trimmed and de-duplicated, or null when there is none. */
function cleanPaths(list) {
	if (!Array.isArray(list)) return null
	const items = [...new Set(list.map(item => String(item ?? '').trim()).filter(item => item !== ''))]
	return items.length === 0 ? null : items
}
