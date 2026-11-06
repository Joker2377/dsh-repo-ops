/**
 * The nine tools dsh-repo-ops puts in front of the model.
 *
 * Shape of every definition follows what installed bundles use: parameters is a
 * flat map of { type, description, required, enum }, defaults are written into
 * the description (the host ignores a schema default), output is a string, and
 * isConcurrencySafe is true only for the read-only tools. execute's second
 * argument carries the session, which is where the working directory comes
 * from - process.cwd() is the host's directory, not the session's project.
 *
 * Design rule: a tool covers one kind of work, not one command. So there are
 * nine tools with an action parameter each, rather than forty tools wrapping
 * every git and gh subcommand, and rather than one mega-tool with a forty-value
 * enum that the model would have to re-read on every call.
 *
 * @module dsh-repo-ops/tools
 */

import * as render from './render.js'
import { clip } from './cli.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools')
	.catch(() => ({ defineTool: definition => definition }))

/** Shared plumbing every tool gets. */
const CONTEXT = { git: null, github: null, settings: {} }

/**
 * The session's working directory, which is not the host process's cwd.
 *
 * @param {any} exec
 * @returns {string | undefined}
 */
function sessionCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd
	return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Text argument sanitation at the boundary: trim, and reject the empty string
 * so a whitespace-only message never reaches git as a valid-looking argument.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed === '' ? undefined : trimmed
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function textList(value) {
	if (value === undefined || value === null) return undefined
	const list = Array.isArray(value) ? value : [value]
	const clean = list.map(item => text(item)).filter(item => item !== undefined)
	return clean.length > 0 ? clean : undefined
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function num(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function flag(value) {
	return value === true
}

/**
 * The read-only switch refuses mutations before anything runs.
 *
 * @param {object} settings
 * @param {string} label
 * @returns {string | null}
 */
function readOnlyBlock(settings, label) {
	if (settings?.readOnly !== true) return null
	return '唯讀模式（config readOnly:true）已停用寫入動作：' + label + '。要放行請把 readOnly 關掉，或由使用者在 profile 調整設定。'
}

const PATH_PARAM = {
	type: 'string',
	description: 'Repo 內任一目錄的絕對路徑（會自動上溯到 repo 根）。預設目前 session 的工作目錄。',
}

const REPO_PARAM = {
	type: 'string',
	description: 'Owner/repo 或完整 GitHub URL，直接進 gh 的 --repo。未给時由本機 git remote 推得。',
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./git.js').createGit>} deps.git
 * @param {ReturnType<import('./github.js').createGithub>} deps.github
 * @param {object} deps.settings
 * @returns {object[]} the nine tool definitions
 */
export function createTools(deps) {
	const git = deps.git
	const github = deps.github
	const settings = deps.settings ?? {}

	return [
		defineTool({
			name: 'repo_status',
			description: [
				'一份「我在哪裡」快照：branch、HEAD、與 upstream 的 ahead/behind、未提交的檔案清單（含 staged/unstaged 分類）、',
				'預設分支、遠端 URL，以及這個 branch 目前的 GitHub PR 與 CI 摘要。用來取代「git status + git log + gh pr view + ',
				'gh pr checks」四輪 shell 與再解析。唯讀，可並行。需要單一檔案的 diff 請改用 repo_diff。',
			].join(''),
			parameters: {
				path: PATH_PARAM,
				repo: REPO_PARAM,
				include: { type: 'array', items: { type: 'string' }, description: '要加什麼額外資訊：checks（逐項 CI）、files（完整檔案清單，即使超過 60 個）、auth（gh 帳號與 scope）。預設只給摘要。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 90000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const status = await git.status({ path: args?.path, cwd })
				if (status.ok !== true) return render.failure(status)
				const repoTarget = { path: args?.path, repo: text(args?.repo), cwd }
				const pr = await github.prStatus({ ...repoTarget, branch: status.branch })
				if (pr.ok === true) {
					status.pr = pr.pr
				} else {
					status.notes = ['GitHub 這側沒回應：' + pr.error]
				}
				if ((textList(args?.include) ?? []).includes('auth')) {
					const auth = await github.authStatus({})
					status.repoLine = auth.ok === true ? (auth.user ?? '') + (auth.host ? ' @ ' + auth.host : '') : undefined
					if (auth.ok !== true) status.notes = [...(status.notes ?? []), 'gh 未就緒：' + auth.error]
				}
				return render.renderStatus(status)
			},
		}),

		defineTool({
			name: 'repo_diff',
			description: [
				'「什麼變了」的四種問法：action=files 看目前工作樹（或暫存區）改了哪些檔與增刪數；action=patch 取 unified diff 原文',
				'（會截斷並標明）；action=log 取 commit 清單（可用 ref/base 限定範圍）；action=show 看某個 commit 的內容。',
				'要看某個 PR 的變動請用 repo_pr action=diff。唯讀，可並行。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['files', 'patch', 'log', 'show'], description: 'files=檔案清單（預設）、patch=diff 原文、log=commit 清單、show=單一 commit。' },
				path: PATH_PARAM,
				repo: REPO_PARAM,
				staged: { type: 'boolean', description: 'files/patch 用：true 看暫存區，預設看未暫存的變更。' },
				base: { type: 'string', description: '比較基準分支（例 origin/main）。給了就等於跑 <base>...HEAD。' },
				ref: { type: 'string', description: 'log/show 用的 commit 或範圍（例 HEAD~5、v0.2.0..HEAD）。' },
				paths: { type: 'array', items: { type: 'string' }, description: '只這些路徑（相對 repo 根或絕對），用来縮小 diff 範圍。' },
				limit: { type: 'number', description: 'log 的筆數上限，預設 20。' },
				maxChars: { type: 'number', description: 'patch 的字元上限，預設 6000；超過會截尾並在結尾標明剩多少。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 90000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'files'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const common = { path: args?.path, cwd, paths: textList(args?.paths) }
				if (action === 'log') {
					const result = await git.log({ ...common, limit: num(args?.limit, 20), ref: text(args?.ref) })
					return render.renderCommits(result)
				}
				if (action === 'show') {
					const result = await git.show({ ...common, ref: text(args?.ref), maxChars: num(args?.maxChars, 6000) })
					return result.ok === true ? render.renderCommits({ ok: true, commits: result.commits ?? [] }) + '\n\n' + render.renderDiff({ ok: true, files: result.files ?? [], patch: result.patch }) : render.failure(result)
				}
				const result = await git.diff({ ...common, staged: flag(args?.staged), base: text(args?.base), ref: text(args?.ref), statOnly: action !== 'patch', maxChars: num(args?.maxChars, 6000) })
				return render.renderDiff(result)
			},
		}),

		defineTool({
			name: 'repo_commit',
			description: [
				'把變更落成一個 commit：stage 指定的檔案並 commit，一條呼叫完成。不會自己 git add -A：未列出的 untracked ',
				'檔案會被跳過並在結果裡標明，要一起提交就得寫進 paths 或 all:true。也支援 amend 與 undo（回頭 soft reset）。',
				'不會跑 --no-verify，pre-commit hook 照跑。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['commit', 'stage', 'undo'], description: 'commit=stage 後提交（預設）、stage=只 stage 不提交、undo=對 HEAD 做 reset --soft HEAD~1（需要 confirm）。' },
				path: PATH_PARAM,
				message: { type: 'string', description: 'commit 主旨（第一行）。commit 必填。' },
				body: { type: 'string', description: 'commit 內文，會成為第二段。' },
				paths: { type: 'array', items: { type: 'string' }, description: '要提交的檔案或目錄（相對 repo 根或絕對）。未给時只提交已經 staged 的東西。' },
				all: { type: 'boolean', description: 'true 才相當於 git add -A（含 untracked）。預設 false。' },
				amend: { type: 'boolean', description: 'true 用 --amend 修改上一個 commit；不給 message 時保留原文（--no-edit）。' },
				allowEmpty: { type: 'boolean', description: 'true 才允許空 commit。預設 false。' },
				confirm: { type: 'boolean', description: 'undo 用：必須為 true 才會真的跑 reset --soft。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 90000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'commit'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const common = { path: args?.path, cwd }
				if (action === 'stage') {
					const blocked = readOnlyBlock(settings, 'stage')
					if (blocked !== null) return '失敗：' + blocked
					const result = await git.stage({ ...common, paths: textList(args?.paths), all: flag(args?.all) })
					return render.renderCommit(result)
				}
				if (action === 'undo') {
					const blocked = readOnlyBlock(settings, 'undo commit')
					if (blocked !== null) return '失敗：' + blocked
					const result = await git.undo({ ...common, kind: 'commit', confirm: flag(args?.confirm) })
					return render.renderAction(result, 'undo commit（soft reset HEAD~1）')
				}
				const blocked = readOnlyBlock(settings, 'commit')
				if (blocked !== null) return '失敗：' + blocked
				const result = await git.commit({
					...common,
					message: text(args?.message),
					body: text(args?.body),
					paths: textList(args?.paths),
					all: flag(args?.all),
					amend: flag(args?.amend),
					allowEmpty: flag(args?.allowEmpty),
				})
				return render.renderCommit(result)
			},
		}),

		defineTool({
			name: 'repo_push',
			description: [
				'把本地 commit 推到遠端，回傳推前/推後的 sha 與遠端的回應（含 GitHub 回來的 PR 網址）。預設一般 push；',
				'forceWithLease 走 --force-with-lease，裸 force 需要同時給 force:true 與 confirm:true，否則只回「會跑這一行」而不執行。',
				'dryRun 走 --dry-run，先看看會發生什麼。',
			].join(''),
			parameters: {
				path: PATH_PARAM,
				branch: { type: 'string', description: '要推的分支，預設目前分支。' },
				remote: { type: 'string', description: '遠端名稱，預設 origin。' },
				setUpstream: { type: 'boolean', description: 'true 加 -u，把遠端分支設為 upstream（新分支第一次推常用）。' },
				forceWithLease: { type: 'boolean', description: 'true 用 --force-with-lease（安全的覆蓋推送）。' },
				force: { type: 'boolean', description: 'true 且 confirm:true 才會用裸 --force。' },
				confirm: { type: 'boolean', description: '破壞性推送的確認旗標。' },
				dryRun: { type: 'boolean', description: 'true 跑 --dry-run，不動遠端。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 120000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const blocked = readOnlyBlock(settings, 'push')
				if (blocked !== null) return '失敗：' + blocked
				const result = await git.push({
					path: args?.path,
					cwd: text(args?.path) ?? sessionCwd(exec),
					branch: text(args?.branch),
					remote: text(args?.remote) ?? 'origin',
					setUpstream: flag(args?.setUpstream),
					forceWithLease: flag(args?.forceWithLease),
					force: flag(args?.force),
					confirm: flag(args?.confirm),
					dryRun: flag(args?.dryRun),
				})
				return render.renderPush(result)
			},
		}),

		defineTool({
			name: 'repo_branch',
			description: [
				'分支與同步：list 列本地/遠端分支與各自 ahead/behind；create 依 base 開新分支；switch 切分支；delete 刪分支',
				'（未合併的會被拒絕，除非 force+confirm）；fetch/pull 同步遠端；sync 把 base 分支接進現在分支。',
				'不開 PR、不 force、不改 history。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['list', 'create', 'switch', 'delete', 'fetch', 'pull', 'sync'], description: '要做什麼，預設 list。' },
				path: PATH_PARAM,
				name: { type: 'string', description: 'create/switch 的分支名。' },
				base: { type: 'string', description: 'create 的起點（分支或 sha，預設目前 HEAD）；sync 的要接進來的分支（預設遠端預設分支）。' },
				checkout: { type: 'boolean', description: 'create 後是否切過去，預設 false。' },
				names: { type: 'array', items: { type: 'string' }, description: 'delete 要刪的分支名（可多個）。' },
				remote: { type: 'string', description: 'delete 的 --remote（刪遠端分支）；fetch/pull 的遠端名稱，預設 origin。' },
				force: { type: 'boolean', description: 'delete 用：未合併分支也要刪時給 true，並要 confirm:true。' },
				confirm: { type: 'boolean', description: 'delete / sync(action=merge) 的確認旗標。' },
				rebase: { type: 'boolean', description: 'pull 用 true 走 --rebase。預設 false（merge）。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 120000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'list'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const common = { path: args?.path, cwd }
				if (action === 'list') return render.renderBranches(await git.branches(common))
				const blocked = readOnlyBlock(settings, 'branch ' + action)
				if (blocked !== null) return '失敗：' + blocked
				if (action === 'create') return render.renderAction(await git.createBranch({ ...common, name: text(args?.name), base: text(args?.base), checkout: flag(args?.checkout) }), 'create branch')
				if (action === 'switch') return render.renderAction(await git.switchBranch({ ...common, name: text(args?.name) }), 'switch branch')
				if (action === 'delete') return render.renderAction(await git.deleteBranch({ ...common, names: textList(args?.names) ?? (text(args?.name) ? [text(args?.name)] : []), force: flag(args?.force), remote: text(args?.remote), confirm: flag(args?.confirm) }), 'delete branch')
				if (action === 'fetch') return render.renderAction(await git.fetch({ ...common, remote: text(args?.remote) ?? 'origin' }), 'fetch')
				if (action === 'pull') return render.renderAction(await git.pull({ ...common, rebase: flag(args?.rebase) }), 'pull')
				return render.renderAction(await git.sync({ ...common, base: text(args?.base), action: 'merge', confirm: flag(args?.confirm) }), 'sync with base')
			},
		}),

		defineTool({
			name: 'repo_pr',
			description: [
				'Pull request 的全部：status 看目前分支的 PR 與 CI；list 列 PR；view 看內容+檔案+checks+未結的 review 執行緒；',
				'create 開 PR（填 title/body/base/head/draft）；update 改標題內文；comment 留言；reply 回某條 review 留言；',
				'diff 看 PR 的變動；checkout 把 PR 分支拉到本地；ready 把 draft 轉正；merge 合併（需要 confirm）。',
				'一次呼叫換掉十次 gh 字串拼接。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['status', 'list', 'view', 'create', 'update', 'comment', 'reply', 'diff', 'checkout', 'ready', 'merge'], description: '要做什麼，預設 status。' },
				path: PATH_PARAM,
				repo: REPO_PARAM,
				number: { type: 'number', description: 'PR 編號。view/update/comment/reply/diff/checkout/ready/merge 需要；未給時 view/status 用現在分支的 PR。' },
				title: { type: 'string', description: 'create 的標題，或 update 的新標題。' },
				body: { type: 'string', description: 'PR 內文或留言內容。多行會被當成一個參數傳下去（不经 shell）。' },
				base: { type: 'string', description: 'create/update 的目標分支，預設 repo 的預設分支。' },
				head: { type: 'string', description: 'create 的來源分支，預設目前分支。' },
				draft: { type: 'boolean', description: 'create 時是否開成 draft。' },
				state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'list 的狀態篩選，預設 open。' },
				author: { type: 'string', description: 'list 的作者篩選（GitHub login，不帶 @）。' },
				limit: { type: 'number', description: 'list 筆數上限，預設 20。' },
				commentId: { type: 'number', description: 'reply 要回的那條 review comment 的 id（由 view 的未結執行緒取得）。' },
				resolve: { type: 'boolean', description: 'reply 時順帶把那條執行緒標為 resolved。' },
				strategy: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'merge 的方式，預設 squash。' },
				deleteBranch: { type: 'boolean', description: 'merge 或 create 後是否刪除來源分支（--delete-branch）。' },
				auto: { type: 'boolean', description: 'true 開 auto-merge（要 repo 有開）。' },
				confirm: { type: 'boolean', description: 'merge 必須 confirm:true 才會執行。' },
				maxChars: { type: 'number', description: 'diff 的字元上限，預設 6000。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 120000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'status'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const target = { path: args?.path, repo: text(args?.repo), cwd }
				const number = typeof args?.number === 'number' ? args.number : undefined
				if (action === 'status') {
					const status = await git.status({ path: args?.path, cwd })
					const result = await github.prStatus({ ...target, branch: status.branch })
					return result.ok === true ? render.renderPrLine(result.pr) : render.failure(result)
				}
				if (action === 'list') return render.renderPrList(await github.prList({ ...target, state: text(args?.state) ?? 'open', author: text(args?.author), limit: num(args?.limit, 20) }))
				if (action === 'view') {
					const result = await github.prView({ ...target, number, files: true, commits: false })
					if (result.ok !== true) return render.failure(result)
					const threads = await github.prReviewComments({ ...target, number: result.pr?.number ?? number })
					return render.renderPrView({ ok: true, pr: result.pr, body: result.pr?.body, files: result.pr?.files, comments: result.comments, reviewThreads: groupThreads(threads.ok === true ? threads.comments : []) })
				}
				if (action === 'diff') return render.renderDiff(await github.prDiff({ ...target, number, maxChars: num(args?.maxChars, 6000) }))
				const blocked = readOnlyBlock(settings, 'pr ' + action)
				if (blocked !== null) return '失敗：' + blocked
				if (action === 'create') return render.renderAction(await github.prCreate({ ...target, title: text(args?.title), body: text(args?.body), base: text(args?.base), head: text(args?.head), draft: flag(args?.draft), deleteBranch: flag(args?.deleteBranch) }), 'create pull request')
				if (action === 'update') return render.renderAction(await github.prUpdate({ ...target, number, title: text(args?.title), body: text(args?.body), base: text(args?.base) }), 'update pull request')
				if (action === 'comment') return render.renderAction(await github.prComment({ ...target, number, body: text(args?.body) }), 'comment pull request')
				if (action === 'reply') return render.renderAction(await github.prReply({ ...target, number, commentId: typeof args?.commentId === 'number' ? args.commentId : undefined, body: text(args?.body), resolve: flag(args?.resolve) }), 'reply to review comment')
				if (action === 'checkout') return render.renderAction(await github.prCheckout({ ...target, number, branch: text(args?.head) }), 'checkout pull request')
				if (action === 'ready') return render.renderAction(await github.prReady({ ...target, number }), 'mark ready')
				return render.renderAction(await github.prMerge({ ...target, number, strategy: text(args?.strategy) ?? 'squash', deleteBranch: flag(args?.deleteBranch), auto: flag(args?.auto), confirm: flag(args?.confirm) }), 'merge pull request')
			},
		}),

		defineTool({
			name: 'repo_ci',
			description: [
				'GitHub Actions：status 現在分支最近 5 條 run 與所有失敗 job；list 列 run；view 一條 run 的 job/step（失敗排前面）；',
				'logs 取失敗 job 的 log 尾端；watch 輪詢等到結束（有上限，不會卡死）；rerun 重跑失敗的 job（要 confirm）；',
				'workflow 列可用 workflow 或觸發 dispatch（要 confirm）。取代 gh run list/view --log/--watch 的手組。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['status', 'list', 'view', 'logs', 'watch', 'rerun', 'workflow'], description: '要做什麼，預設 status。' },
				path: PATH_PARAM,
				repo: REPO_PARAM,
				branch: { type: 'string', description: '篩選分支，預設目前分支（status/list）。' },
				runId: { type: 'number', description: 'workflow run id（view/logs/watch/rerun 需要）。' },
				job: { type: 'number', description: 'logs 只看這個 job。' },
				limit: { type: 'number', description: 'list 筆數上限，預設 20。' },
				workflow: { type: 'string', description: 'list 的 workflow 名稱/檔名；workflow action=run 要觸發的那個。' },
				ref: { type: 'string', description: 'workflow 觸發的 branch/tag，預設目前分支。' },
				failedOnly: { type: 'boolean', description: 'logs/rerun 是否只看失敗部分，預設 true。' },
				tailLines: { type: 'number', description: 'logs 取尾端幾行，預設 200。' },
				timeoutMs: { type: 'number', description: 'watch 的等待上限（ms），預設 300000。' },
				confirm: { type: 'boolean', description: 'rerun / workflow 執行需要 true。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 330000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'status'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const target = { path: args?.path, repo: text(args?.repo), cwd }
				// gh returns run ids as strings in --json, so a value copied from
				// repo_ci list must not be rejected for not being a number.
				const runId = args?.runId === undefined || args?.runId === null || String(args.runId).trim() === '' || !Number.isFinite(Number(args.runId)) ? undefined : Number(args.runId)
				if (action === 'status') {
					const result = await github.ciStatus({ ...target, branch: text(args?.branch) })
					if (result.ok !== true) return render.failure(result)
					return render.renderRuns(result) + (result.failing?.length ? '\n\n失敗的 job：\n' + result.failing.slice(0, 12).map(item => '  run ' + item.runId + ' / ' + (item.name ?? item.job ?? '?')).join('\n') : '')
				}
				if (action === 'list') return render.renderRuns(await github.ciList({ ...target, branch: text(args?.branch), workflow: text(args?.workflow), limit: num(args?.limit, 20) }))
				if (action === 'view') return render.renderRunView(await github.ciView({ ...target, runId }))
				if (action === 'logs') return render.renderRunView(await github.ciLogs({ ...target, runId, job: typeof args?.job === 'number' ? args.job : undefined, failedOnly: args?.failedOnly !== false, tailLines: num(args?.tailLines, 200) }))
				if (action === 'watch') return render.renderWatch(await github.ciWatch({ ...target, runId, timeoutMs: num(args?.timeoutMs, settings.watchTimeoutMs ?? 300000) }))
				const blocked = readOnlyBlock(settings, 'ci ' + action)
				if (blocked !== null) return '失敗：' + blocked
				if (action === 'rerun') return render.renderAction(await github.ciRerun({ ...target, runId, failedOnly: args?.failedOnly !== false, confirm: flag(args?.confirm) }), 'rerun workflow')
				const workflows = await github.workflowList(target)
				if (workflows.ok !== true) return render.failure(workflows)
				return 'workflows:\n' + clip((workflows.workflows ?? []).map(item => '  ' + (item.id ?? '') + '  ' + (item.name ?? '') + '  [' + (item.state ?? '?') + ']').join('\n'), 2000)
			},
		}),

		defineTool({
			name: 'repo_issue',
			description: [
				'Issue：list 列 issue（可用 state/assignee 篩）、view 看內文與留言、create 開 issue、comment 留言、',
				'setState 關閉或重開。取代一串串 gh issue 指令與手動解析。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['list', 'view', 'create', 'comment', 'close', 'reopen'], description: '要做什麼，預設 list。' },
				path: PATH_PARAM,
				repo: REPO_PARAM,
				number: { type: 'number', description: 'issue 編號（view/comment/close/reopen 需要）。' },
				title: { type: 'string', description: 'create 的標題。' },
				body: { type: 'string', description: 'create 的內文或留言內容。' },
				state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list 的篩選，預設 open。' },
				assignee: { type: 'string', description: 'list 的 assignee 篩選。' },
				limit: { type: 'number', description: 'list 筆數上限，預設 20。' },
				labels: { type: 'array', items: { type: 'string' }, description: 'create 要貼的 label。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 90000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'list'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const target = { path: args?.path, repo: text(args?.repo), cwd }
				const number = typeof args?.number === 'number' ? args.number : undefined
				if (action === 'list') return render.renderIssues(await github.issueList({ ...target, state: text(args?.state) ?? 'open', assignee: text(args?.assignee), limit: num(args?.limit, 20) }))
				if (action === 'view') return render.renderIssueView(await github.issueView({ ...target, number }))
				const blocked = readOnlyBlock(settings, 'issue ' + action)
				if (blocked !== null) return '失敗：' + blocked
				if (action === 'create') return render.renderAction(await github.issueCreate({ ...target, title: text(args?.title), body: text(args?.body), labels: textList(args?.labels) }), 'create issue')
				if (action === 'comment') return render.renderAction(await github.issueComment({ ...target, number, body: text(args?.body) }), 'comment issue')
				return render.renderAction(await github.issueSetState({ ...target, number, state: action === 'reopen' ? 'open' : 'closed' }), action)
			},
		}),

		defineTool({
			name: 'repo_release',
			description: [
				'Release 與 tag：list 列 release（含資產檔名）、view 看某個 release、create 發 release（tag + assets + body）、',
				'edit 改草案/標記、delete 刪（要 confirm）、tags 列 git tag。發版流程（打 tag、推 tag、發 release）由呼叫端決定順序，',
				'這個工具只保證每一歩的 argv 正確並把 gh 的回覆整理成一段文字。',
			].join(''),
			parameters: {
				action: { type: 'string', enum: ['list', 'view', 'create', 'edit', 'delete', 'tags', 'createTag'], description: '要做什麼，預設 list。' },
				path: PATH_PARAM,
				repo: REPO_PARAM,
				tag: { type: 'string', description: 'release/tag 名稱，例如 v0.2.0。' },
				name: { type: 'string', description: 'release 的標題。' },
				body: { type: 'string', description: 'release 說明（或 generateNotes:true 讓 GitHub 自己生）。' },
				assets: { type: 'array', items: { type: 'string' }, description: '要上傳的檔案絕對路徑（每個是獨立參數）。' },
				generateNotes: { type: 'boolean', description: 'true 用 --generate-notes。' },
				draft: { type: 'boolean', description: 'true 開成草案。' },
				prerelease: { type: 'boolean', description: 'true 標為 pre-release。' },
				latest: { type: 'boolean', description: '是否標為 latest；預設 true（要取消給 false）。' },
				message: { type: 'string', description: 'createTag 的 annotated tag 說明（不給就做 lightweight tag）。' },
				pushTo: { type: 'string', description: 'createTag 後要推到哪個遠端（例 origin）；未给就不推。' },
				deleteTag: { type: 'boolean', description: 'delete 時連 tag 一起刪（要 confirm）。' },
				confirm: { type: 'boolean', description: 'delete 需要 true。' },
			},
			output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
			timeoutMs: 120000,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = text(args?.action) ?? 'list'
				const cwd = text(args?.path) ?? sessionCwd(exec)
				const target = { path: args?.path, repo: text(args?.repo), cwd }
				if (action === 'list') return render.renderReleases(await github.releaseList({ ...target, limit: num(args?.limit, 10) }))
				if (action === 'view') return render.renderReleaseView(await github.releaseView({ ...target, tag: text(args?.tag) }))
				if (action === 'tags') {
					const tags = await git.tag({ path: args?.path, cwd, action: 'list' })
					if (tags.ok !== true || text(args?.repo) === undefined || args?.path !== undefined) return render.renderTags(tags)
					return render.renderTags(tags) + '\n（這是 ' + cwd + ' 的本地 tag；遠端 release 用 action=list 看）'
				}
				const blocked = readOnlyBlock(settings, 'release ' + action)
				if (blocked !== null) return '失敗：' + blocked
				if (action === 'createTag') return render.renderAction(await git.tag({ path: args?.path, cwd, action: 'create', name: text(args?.tag), message: text(args?.message), pushTo: text(args?.pushTo) }), 'create tag')
				if (action === 'create') return render.renderAction(await github.releaseCreate({ ...target, tag: text(args?.tag), name: text(args?.name), body: text(args?.body), assets: textList(args?.assets), draft: flag(args?.draft), prerelease: flag(args?.prerelease), latest: args?.latest !== false, generateNotes: flag(args?.generateNotes) }), 'create release')
				if (action === 'edit') return render.renderAction(await github.releaseEdit({ ...target, tag: text(args?.tag), name: text(args?.name), body: text(args?.body), draft: args?.draft === true ? true : args?.draft === false ? false : undefined, prerelease: args?.prerelease === true ? true : args?.prerelease === false ? false : undefined }), 'edit release')
				return render.renderAction(await github.releaseDelete({ ...target, tag: text(args?.tag), deleteTag: flag(args?.deleteTag), confirm: flag(args?.confirm) }), 'delete release')
			},
		}),
	]
}

/**
 * Turn the flat review-comment list into threads, so the view can say which
 * discussions are still open. A comment with inReplyToId joins its parent's
 * thread; anything else starts one.
 *
 * @param {{ id: string | number, body?: string, path?: string, author?: string, inReplyToId?: string | number, resolved?: boolean }[]} comments
 * @returns {{ isResolved: boolean, comments: { author: { login: string }, body: string, path: string }[] }[]}
 */
export function groupThreads(comments) {
	const threads = []
	const index = new Map()
	for (const comment of comments ?? []) {
		const author = { login: comment?.author ?? '?' }
		const entry = { author, body: comment?.body ?? '', path: comment?.path ?? '' }
		const parentId = comment?.inReplyToId === undefined || comment?.inReplyToId === null ? undefined : String(comment.inReplyToId)
		const target = parentId !== undefined ? index.get(parentId) : undefined
		if (target !== undefined) {
			target.comments.push(entry)
			if (comment?.resolved === false) target.isResolved = false
			continue
		}
		const thread = { isResolved: comment?.resolved === true, comments: [entry] }
		threads.push(thread)
		if (comment?.id !== undefined && comment?.id !== null) index.set(String(comment.id), thread)
	}
	return threads
}
