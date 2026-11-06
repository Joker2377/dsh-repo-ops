/**
 * Data-to-text rendering for the tool results.
 *
 * Pure on purpose: every function takes the shape lib/git.js and lib/github.js
 * return and produces the string the model reads. Keeping it separate is what
 * lets the wording be tested without a repo, a binary, or a network. Two rules:
 * one fact per line, and a line that names a next step when something is
 * missing - the model acts on hints, not on silence.
 *
 * @module dsh-repo-ops/render
 */

import { clip } from './cli.js'
import { checkMark, checkSummary, fields, plural, table } from './format.js'

/**
 * The "where am I" report: identity, branch position, dirty files, and the
 * GitHub state of that branch when gh could answer.
 *
 * @param {{ ok: boolean, error?: string, needsConfirm?: boolean, root?: string, branch?: string, detached?: boolean, head?: { sha?: string, subject?: string }, upstream?: { name?: string } | null, ahead?: number | null, behind?: number | null, defaultBranch?: string | null, remoteUrl?: string, files?: { xy: string, status: string, path: string, original?: string }[], stagedCount?: number, unstagedCount?: number, untrackedCount?: number, clean?: boolean, hint?: string, pr?: object | null, repoLine?: string, notes?: string[] }} data
 * @returns {string}
 */
export function renderStatus(data) {
	if (data?.ok !== true) return failure(data)
	const lines = [fields({
		repo: data.root,
		branch: data.detached ? '(detached)' : data.branch,
		head: data.head?.short ? data.head.short + ' ' + (data.head.subject ?? '') : undefined,
		upstream: data.upstream?.name ?? null,
		tracking: data.ahead === null || data.ahead === undefined ? undefined : '+' + (data.ahead ?? 0) + '/-' + (data.behind ?? 0),
		default: data.defaultBranch ?? undefined,
		remote: data.remoteUrl,
		repoRef: data.repoLine,
	})]
	const counts = [
		data.stagedCount ? plural(data.stagedCount, 'staged change') : null,
		data.unstagedCount ? plural(data.unstagedCount, 'unstaged change') : null,
		data.untrackedCount ? plural(data.untrackedCount, 'untracked file') : null,
	].filter(Boolean)
	lines.push('')
	lines.push('working tree: ' + (counts.length > 0 ? counts.join(', ') : 'clean'))
	const files = data.files ?? []
	if (files.length > 0) {
		lines.push(table([
			{ key: 'xy', label: 'xy', width: 4 },
			{ key: 'path', label: 'path', width: 90 },
		], files.slice(0, 60).map(file => ({ xy: file.xy, path: file.original ? file.original + ' -> ' + file.path : file.path }))))
		if (files.length > 60) lines.push('…另有 ' + (files.length - 60) + ' 個檔案未列出')
	}
	if (data.pr !== undefined) lines.push('', renderPrLine(data.pr))
	if (data.notes?.length) lines.push('', ...data.notes)
	if (data.hint) lines.push('', 'hint: ' + data.hint)
	return lines.filter(line => line !== undefined).join('\n')
}

/**
 * One-line PR summary with its checks.
 *
 * @param {{ number?: number, title?: string, state?: string, isDraft?: boolean, url?: string, headRefName?: string, baseRefName?: string, reviewDecision?: string, mergeable?: string, mergeStateStatus?: string, checks?: { name: string, bucket: string, state?: string, conclusion?: string, url?: string }[], mergeQueueState?: string } | null} pr
 * @returns {string}
 */
export function renderPrLine(pr) {
	if (pr === null || pr === undefined) return 'pull request: none for this branch'
	const bits = [
		' #' + (pr.number ?? '?'),
		pr.state ?? '?',
		pr.isDraft ? 'draft' : null,
		pr.headRefName && pr.baseRefName ? pr.headRefName + ' -> ' + pr.baseRefName : null,
		pr.reviewDecision && pr.reviewDecision !== 'REVIEW_REQUIRED' ? pr.reviewDecision : null,
		pr.mergeable ? 'mergeable=' + pr.mergeable : null,
		pr.mergeStateStatus ? 'state=' + pr.mergeStateStatus : null,
		pr.mergeQueueState ? 'queue=' + pr.mergeQueueState : null,
	].filter(Boolean).join(' ')
	const lines = ['pull request:' + bits, pr.title ? '  ' + pr.title : null]
	if (pr.url) lines.push('  ' + pr.url)
	if (pr.checks?.length) {
		lines.push('  ' + checkSummary(pr.checks.map(check => ({ status: check.state ?? check.status, conclusion: check.conclusion }))))
		const bad = pr.checks.filter(check => check.bucket === 'fail' || check.bucket === 'pending').slice(0, 12)
		for (const check of bad) lines.push('    ' + markFor(check.bucket) + ' ' + check.name + (check.conclusion ? ' (' + check.conclusion + ')' : ''))
		const other = pr.checks.filter(check => check.bucket !== 'fail' && check.bucket !== 'pending')
		if (other.length > 0) lines.push('    其他 ' + plural(other.length, 'check', 'checks') + ' 通過或略過')
	}
	return lines.filter(Boolean).join('\n')
}

function markFor(bucket) {
	return { pass: '[PASS]', fail: '[FAIL]', pending: '[WAIT]', skipped: '[SKIP]', neutral: '[--  ]', unknown: '[?   ]' }[bucket] ?? '[?   ]'
}

/**
 * Changed files with their numbers, plus an optional patch.
 *
 * @param {{ ok: boolean, error?: string, stat?: string, patch?: string, files?: { path: string, additions?: number, deletions?: number }[], range?: string, truncated?: boolean }} data
 * @returns {string}
 */
export function renderDiff(data) {
	if (data?.ok !== true) return failure(data)
	const lines = []
	if (data.range) lines.push('range: ' + data.range)
	const files = data.files ?? []
	if (files.length === 0) lines.push('(no changed files)')
	else {
		lines.push(table([
			{ key: 'sign', label: '+/-', width: 10, align: 'right' },
			{ key: 'path', label: 'path', width: 90 },
		], files.slice(0, 80).map(file => ({ sign: '+' + (file.additions ?? 0) + ' -' + (file.deletions ?? 0), path: file.path }))))
		if (files.length > 80) lines.push('…另有 ' + (files.length - 80) + ' 個檔案未列出（用 maxChars 或 filterPath 縮小）')
		lines.push(plural(files.reduce((sum, file) => sum + (file.additions ?? 0), 0), 'insertion') + ', ' + plural(files.reduce((sum, file) => sum + (file.deletions ?? 0), 0), 'deletion'))
	}
	if (data.patch) lines.push('', clip(data.patch, data.maxChars ?? 6000))
	return lines.join('\n')
}

/**
 * Commit list.
 *
 * @param {{ ok: boolean, error?: string, commits?: { short: string, subject: string, author?: string, date?: string }[], range?: string }} data
 * @returns {string}
 */
export function renderCommits(data) {
	if (data?.ok !== true) return failure(data)
	const commits = data.commits ?? []
	if (commits.length === 0) return '(no commits' + (data.ref ? ' in ' + data.ref : '') + ')'
	return [
		data.range ? 'range: ' + data.range : null,
		table([
			{ key: 'short', label: 'sha', width: 10 },
			{ key: 'date', label: 'date', width: 10 },
			{ key: 'author', label: 'author', width: 18 },
			{ key: 'subject', label: 'subject', width: 80 },
		], commits),
	].filter(Boolean).join('\n')
}

/**
 * The result of a local mutation: what ran, what it produced.
 *
 * @param {{ ok: boolean, error?: string, needsConfirm?: boolean, command?: string, sha?: string, short?: string, summary?: string, added?: string[], skippedUntracked?: string[], nothingToCommit?: boolean, emptyRejected?: boolean, undone?: string }} data
 * @returns {string}
 */
export function renderCommit(data) {
	if (data?.ok !== true) {
		if (data?.needsConfirm === true) return confirmNeeded(data)
		if (data?.nothingToCommit === true) return 'nothing to commit：工作樹與 HEAD 相同（要建立空 commit 請傳 allowEmpty:true）'
		return failure(data)
	}
	const lines = []
	if (data.added?.length) lines.push('staged: ' + data.added.slice(0, 20).join(', ') + (data.added.length > 20 ? ' …' + (data.added.length - 20) + ' more' : ''))
	if (data.skippedUntracked?.length) lines.push('untracked 未自動加入（要納入請把它們寫進 paths）: ' + data.skippedUntracked.slice(0, 12).join(', '))
	lines.push('committed: ' + (data.short ?? data.sha ?? '?') + (data.summary ? '  ' + data.summary : ''))
	if (data.command) lines.push('ran: ' + data.command)
	return lines.join('\n')
}

/**
 * A push, with the remote's answer.
 *
 * @param {{ ok: boolean, error?: string, needsConfirm?: boolean, command?: string, before?: string, after?: string, output?: string, dryRun?: boolean, prUrl?: string, branch?: string, setUpstream?: boolean, createdPr?: boolean, upstream?: string }} data
 * @returns {string}
 */
export function renderPush(data) {
	if (data?.ok !== true) return data?.needsConfirm === true ? confirmNeeded(data) : failure(data)
	const lines = [
		fields({
			branch: data.branch,
			upstream: data.upstream,
		 moved: data.before && data.after ? data.before + ' -> ' + data.after : undefined,
			mode: data.dryRun ? 'dry-run（遠端未變動）' : undefined,
		}),
	]
	if (data.output) lines.push(clip(data.output.trim(), 1500))
	if (data.prUrl) lines.push('pull request: ' + data.prUrl)
	if (data.createdPr === false && data.dryRun !== true) lines.push('hint: 這個 branch 目前沒有 PR；要開就呼叫 repo_pr action=create')
	if (data.command) lines.push('ran: ' + data.command)
	return lines.filter(Boolean).join('\n')
}

/**
 * Branch list.
 *
 * @param {{ ok: boolean, error?: string, local?: { name: string, current?: boolean, upstream?: string, ahead?: number | null, behind?: number | null, subject?: string }[], remote?: string[] }} data
 * @returns {string}
 */
export function renderBranches(data) {
	if (data?.ok !== true) return failure(data)
	const local = data.local ?? []
	const lines = [table([
		{ key: 'mark', label: '', width: 2 },
		{ key: 'name', label: 'branch', width: 36 },
		{ key: 'position', label: '+/-', width: 8, align: 'right' },
		{ key: 'upstream', label: 'upstream', width: 34 },
		{ key: 'subject', label: 'subject', width: 44 },
	], local.map(row => ({
		mark: row.current ? '*' : ' ',
		name: row.name,
		position: row.ahead === null || row.ahead === undefined ? '-' : '+' + row.ahead + '/-' + (row.behind ?? 0),
		upstream: row.upstream ?? '-',
		subject: row.subject ?? '',
	})))]
	if (data.remote?.length) lines.push('', 'remote branches: ' + clip(data.remote.join(', '), 1200))
	return lines.join('\n')
}

/**
 * PR list.
 *
 * @param {{ ok: boolean, error?: string, prs?: { number: number, title: string, state: string, isDraft?: boolean, headRefName?: string, baseRefName?: string, reviewDecision?: string, checksSummary?: string }[] }} data
 * @returns {string}
 */
export function renderPrList(data) {
	if (data?.ok !== true) return failure(data)
	const prs = data.prs ?? []
	if (prs.length === 0) return '(找不到符合的 pull request)'
	return table([
		{ key: 'number', label: '#', width: 6, align: 'right' },
		{ key: 'state', label: 'state', width: 7 },
		{ key: 'draft', label: 'draft', width: 5 },
		{ key: 'refs', label: 'head -> base', width: 44 },
		{ key: 'review', label: 'review', width: 16 },
		{ key: 'title', label: 'title', width: 60 },
	], prs.map(pr => ({
		number: pr.number,
		state: pr.state ?? '?',
		draft: pr.isDraft ? 'yes' : 'no',
		refs: (pr.headRefName ?? '?') + ' -> ' + (pr.baseRefName ?? '?'),
		review: pr.reviewDecision ?? '-',
		title: pr.title ?? '',
	})))
}

/**
 * Everything the model needs about one PR: header, body head, files, checks,
 * and the review comments waiting for an answer.
 *
 * @param {{ ok: boolean, error?: string, pr?: object, body?: string, files?: object[], comments?: { author?: string, body?: string }[], reviewThreads?: { isResolved?: boolean, comments?: { author?: { login?: string }, body?: string, path?: string }[] } }} data
 * @returns {string}
 */
export function renderPrView(data) {
	if (data?.ok !== true) return failure(data)
	const lines = [renderPrLine(data.pr)]
	const pr = data.pr ?? {}
	if (pr.url) lines.push(pr.url)
	if (data.body) lines.push('', 'body:', clip(data.body, 2500))
	if (data.files?.length) {
		lines.push('', 'files:', renderDiff({ ok: true, files: data.files }).split('\n').slice(0, 40).join('\n'))
	}
	if (pr.checks?.length) lines.push('', 'checks:', ...pr.checks.slice(0, 40).map(check => '  ' + markFor(check.bucket) + ' ' + check.name + (check.conclusion ? ' (' + check.conclusion + ')' : '')))
	const unresolved = (data.reviewThreads ?? []).filter(thread => thread.isResolved !== true)
	if (unresolved.length > 0) {
		lines.push('', plural(unresolved.length, 'unresolved review thread'))
		for (const thread of unresolved.slice(0, 8)) {
			const comment = thread.comments?.[0]
			lines.push('  ' + (comment?.author?.login ?? '?') + ' @ ' + (comment?.path ?? '?') + ': ' + clip(comment?.body ?? '', 240).replace(/\n/g, ' '))
		}
		lines.push('  （要回覆：repo_pr action=comment，用 commentId 指向那條）')
	}
	if (data.comments?.length) lines.push('', 'issue comments: ' + data.comments.length)
	return lines.join('\n')
}

/**
 * CI runs.
 *
 * @param {{ ok: boolean, error?: string, runs?: { databaseId?: number, id?: number, name?: string, displayTitle?: string, branch?: string, event?: string, status?: string, conclusion?: string, bucket?: string, createdAt?: string, url?: string }[] }} data
 * @returns {string}
 */
export function renderRuns(data) {
	if (data?.ok !== true) return failure(data)
	const runs = data.runs ?? []
	if (runs.length === 0) return '(找不到 workflow run)'
	return table([
		{ key: 'id', label: 'run', width: 11, align: 'right' },
		{ key: 'mark', label: '', width: 7 },
		{ key: 'name', label: 'workflow', width: 26 },
		{ key: 'title', label: 'title', width: 40 },
		{ key: 'branch', label: 'branch', width: 22 },
		{ key: 'event', label: 'event', width: 12 },
		{ key: 'at', label: 'at', width: 20 },
	], runs.map(run => ({
		id: run.databaseId ?? run.id,
		mark: markFor(run.bucket),
		name: run.name ?? '',
		title: run.displayTitle ?? '',
		branch: run.branch ?? '',
		event: run.event ?? '',
		at: String(run.createdAt ?? '').replace('T', ' ').slice(0, 19),
	})))
}

/**
 * One CI run with its jobs and steps; failed parts first, because that is the
 * question the call was made to answer.
 *
 * @param {{ ok: boolean, error?: string, run?: { databaseId?: number, name?: string, status?: string, conclusion?: string, url?: string, jobs?: { databaseId?: number, name?: string, status?: string, conclusion?: string, bucket?: string, steps?: { name: string, status?: string, conclusion?: string, bucket?: string }[] }[] }, logs?: string }} data
 * @returns {string}
 */
export function renderRunView(data) {
	if (data?.ok !== true) return failure(data)
	const run = data.run ?? {}
	const jobs = run.jobs ?? []
	const lines = [fields({
		run: run.databaseId,
		workflow: run.name,
		status: run.status,
		conclusion: run.conclusion,
		url: run.url,
	})]
	const failed = jobs.filter(job => job.bucket === 'fail')
	const ordered = [...failed, ...jobs.filter(job => job.bucket !== 'fail')]
	for (const job of ordered) {
		lines.push(markFor(job.bucket) + ' ' + (job.name ?? job.databaseId ?? '?'))
		const steps = job.steps ?? []
		const badSteps = steps.filter(step => step.bucket === 'fail' || step.bucket === 'pending')
		for (const step of (badSteps.length > 0 ? badSteps : steps).slice(0, 12)) {
			lines.push('    ' + markFor(step.bucket) + ' ' + step.name)
		}
		if (steps.length > 12 && badSteps.length === 0) lines.push('    （' + plural(steps.length, 'step', 'steps') + ' 全部成功）')
	}
	if (data.logs) lines.push('', 'log（尾端）:', clip(data.logs, 4000))
	else if (failed.length > 0) lines.push('', 'hint: 要失敗段落原文呼叫 repo_ci action=logs 附 runId')
	return lines.filter(Boolean).join('\n')
}

/**
 * A CI wait result.
 *
 * @param {{ ok: boolean, error?: string, status?: string, conclusion?: string, url?: string, waitedMs?: number, timedOut?: boolean, runId?: number }} data
 * @returns {string}
 */
export function renderWatch(data) {
	if (data?.ok !== true) return failure(data)
	return fields({
		run: data.runId,
		status: data.status,
		conclusion: data.conclusion,
		waited: Math.round((data.waitedMs ?? 0) / 1000) + 's',
		result: data.timedOut === true ? '還在跑（等待已到期；再用一次 repo_ci action=watch 繼續等）' : undefined,
		url: data.url,
	})
}

/**
 * Issues, one row each.
 *
 * @param {{ ok: boolean, error?: string, issues?: { number: number, title: string, state?: string, updatedAt?: string, url?: string }[] }} data
 * @returns {string}
 */
export function renderIssues(data) {
	if (data?.ok !== true) return failure(data)
	const issues = data.issues ?? []
	if (issues.length === 0) return '(找不到 issue)'
	return table([
		{ key: 'number', label: '#', width: 6, align: 'right' },
		{ key: 'state', label: 'state', width: 7 },
		{ key: 'updated', label: 'updated', width: 11 },
		{ key: 'title', label: 'title', width: 84 },
	], issues.map(issue => ({
		number: issue.number,
		state: issue.state === 'MERGED' ? 'merged' : String(issue.state ?? '?').toLowerCase(),
		updated: String(issue.updatedAt ?? '').slice(0, 10),
		title: issue.title ?? '',
	})))
}

/**
 * One issue with its body and comments.
 *
 * @param {{ ok: boolean, error?: string, issue?: { number?: number, title?: string, state?: string, url?: string, body?: string, labels?: { name?: string }[] }, comments?: { author?: { login?: string }, createdAt?: string, body?: string }[] }} data
 * @returns {string}
 */
export function renderIssueView(data) {
	if (data?.ok !== true) return failure(data)
	const issue = data.issue ?? {}
	const lines = [fields({
		issue: issue.number,
		state: issue.state,
		title: issue.title,
		labels: (issue.labels ?? []).map(label => label?.name).filter(Boolean),
		url: issue.url,
	})]
	if (issue.body) lines.push('', clip(issue.body, 4000))
	for (const comment of data.comments ?? []) {
		lines.push('', '--- ' + (comment?.author?.login ?? '?') + ' @ ' + String(comment?.createdAt ?? '').replace('T', ' ').slice(0, 19), clip(comment?.body ?? '', 1500))
	}
	return lines.join('\n')
}

/**
 * Releases.
 *
 * @param {{ ok: boolean, error?: string, releases?: { tagName: string, name?: string, isDraft?: boolean, isPrerelease?: boolean, isLatest?: boolean, publishedAt?: string, url?: string, assets?: { name: string, size?: number }[] }[] }} data
 * @returns {string}
 */
export function renderReleases(data) {
	if (data?.ok !== true) return failure(data)
	const releases = data.releases ?? []
	if (releases.length === 0) return '(還沒有 release)'
	// gh release list has no assets field, so an empty list there means "not
	// fetched", not "no files". Showing "-" would be a small lie; drop the
	// column and say where the answer lives instead.
	const known = data.assetsKnown !== false
	const columns = [
		{ key: 'tag', label: 'tag', width: 18 },
		{ key: 'name', label: 'name', width: 24 },
		{ key: 'flags', label: 'flags', width: 22 },
	]
	if (known) columns.push({ key: 'assets', label: 'assets', width: 40 })
	columns.push({ key: 'at', label: 'published', width: 11 })
	const text = table(columns, releases.map(release => ({
		tag: release.tag ?? release.tagName,
		name: release.name ?? '',
		flags: [release.isDraft ? 'draft' : null, release.isPrerelease ? 'prerelease' : null, release.isLatest ? 'latest' : null].filter(Boolean).join(',') || '-',
		assets: (release.assets ?? []).map(asset => asset.name).join(' ') || '-',
		at: String(release.publishedAt ?? '').slice(0, 10),
	})))
	if (known) return text
	return text + '\n(gh release list 不帶附檔：要看清單用 action=view tag=<tag>)'
}

/**
 * One release with its files and notes.
 *
 * @param {{ ok: boolean, error?: string, release?: { tag?: string, name?: string, isDraft?: boolean, isPrerelease?: boolean, isLatest?: boolean, publishedAt?: string, url?: string, body?: string, assets?: { name?: string, size?: number, url?: string }[] } }} data
 * @returns {string}
 */
export function renderReleaseView(data) {
	if (data?.ok !== true) return failure(data)
	const release = data.release ?? {}
	const lines = [fields({
		tag: release.tag,
		name: release.name,
		flags: [release.isDraft ? 'draft' : null, release.isPrerelease ? 'prerelease' : null, release.isLatest ? 'latest' : null].filter(Boolean).join(',') || undefined,
		published: String(release.publishedAt ?? '').slice(0, 10) || undefined,
		url: release.url,
	})]
	const assets = release.assets ?? []
	if (assets.length === 0) lines.push('', 'assets: (沒有附檔)')
	else {
		lines.push('', 'assets:')
		for (const asset of assets) {
			const kb = Number.isFinite(asset?.size) ? '  ' + Math.max(1, Math.round(asset.size / 1024)) + ' KB' : ''
			lines.push('  ' + (asset?.name ?? '?') + kb + (asset?.url ? '  ' + asset.url : ''))
		}
	}
	if (release.body) lines.push('', clip(release.body, 4000))
	return lines.join('\n')
}

/**
 * A tag list.
 *
 * @param {{ ok: boolean, error?: string, tags?: { name: string, subject?: string }[] }} data
 * @returns {string}
 */
export function renderTags(data) {
	if (data?.ok !== true) return failure(data)
	const tags = data.tags ?? []
	if (tags.length === 0) return '(這個 repo 沒有 tag)'
	return tags.slice(0, 80).map(tag => tag.name + (tag.subject ? '  ' + tag.subject : '')).join('\n')
}

/**
 * What ran, and what came back, for the mutating actions that have no richer
 * shape of their own.
 *
 * @param {{ ok: boolean, error?: string, needsConfirm?: boolean, command?: string, url?: string, number?: number, note?: string, changed?: string[] }} data
 * @param {string} label what the action was, in Chinese
 * @returns {string}
 */
export function renderAction(data, label) {
	if (data?.ok !== true) return data?.needsConfirm === true ? confirmNeeded(data) : failure(data)
	const lines = [label + ': ok']
	if (data.number !== undefined) lines.push('number: ' + data.number)
	if (data.url) lines.push('url: ' + data.url)
	if (data.changed?.length) lines.push('changed: ' + data.changed.join(', '))
	if (data.note) lines.push(data.note)
	if (data.command) lines.push('ran: ' + data.command)
	return lines.join('\n')
}

/**
 * The confirm gate: what would run, and nothing did.
 *
 * @param {{ error?: string, command?: string, danger?: string }} data
 * @returns {string}
 */
export function confirmNeeded(data) {
	return [
	 '需要明確確認才會執行：' + (data?.error ?? '這是破壞性動作'),
	 data?.danger ? '風險：' + data.danger : null,
	 data?.command ? '會跑：' + data.command : null,
	 '要執行請在同一組參數加 confirm:true（先確認這正是使用者要的事）。',
	].filter(Boolean).join('\n')
}

/**
 * The uniform failure line.
 *
 * @param {{ error?: string, hint?: string }} data
 * @returns {string}
 */
export function failure(data) {
	const error = data?.error ?? '未知失敗'
	return '失敗：' + error + (data?.hint ? '\nhint: ' + data.hint : '')
}

/**
 * GitHub identity, which every GitHub-side tool may need to explain itself.
 *
 * @param {{ ok: boolean, error?: string, user?: string, host?: string, repo?: string, defaultBranch?: string, scopes?: string[], source?: string, ghVersion?: string, gitVersion?: string }} data
 * @returns {string}
 */
export function renderAuth(data) {
	if (data?.ok !== true) return failure(data)
	return fields({
		account: data.user,
		host: data.host,
		repo: data.repo,
		defaultBranch: data.defaultBranch,
		scopes: data.scopes,
		source: data.source,
		cli: [data.ghVersion ? 'gh ' + data.ghVersion : null, data.gitVersion ? 'git ' + data.gitVersion : null].filter(Boolean).join(' / '),
	})
}
