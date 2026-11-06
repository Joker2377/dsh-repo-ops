/**
 * Everything this plugin does through the GitHub CLI.
 *
 * Two rules decide the shape of this file. First, every call is an argv array
 * handed to the runner in lib/cli.js - never a shell string - so a branch named
 * "fix; rm -rf /" stays one argument. Second, nothing here throws: a failed gh
 * run comes back as { ok:false, error } with one Chinese sentence naming the
 * next step, because the reader of the result is a model that must decide what
 * to do next, not a stack it can walk.
 *
 * Repo targeting follows the contract: an explicit repo (owner/name or a repo
 * URL) wins, otherwise the injected gitInfo hook - lib/git.js owns git, this
 * module never runs it - supplies owner and repo from the caller's path, and
 * when neither is available the call fails asking for repo.
 *
 * Field names in the JSON constants were read off the gh on this machine with
 * "gh <command> --json" (no value), which prints the names that command accepts
 * (gh 2.92.0). Three of them cost a real bug each, and each is called out where
 * it appears: run list exposes headBranch rather than branch, release list has
 * no url or assets field, and gh supports NO nested field selection at all -
 * `--json 'jobs{name}'` and `--json 'assets{name}'` are rejected with `Unknown
 * JSON field`, so every constant below is a flat top-level name and the
 * narrowing happens in the mappers instead.
 *
 * @module dsh-repo-ops/github
 */

import { clip, firstLine, parseJson, redactSecrets } from './cli.js'
import { bucketOf, isTerminal } from './bucket.js'

/**
 * Fields for gh pr view and gh pr edit: everything the contract reports about a
 * pull request, including the whole check rollup, so one call answers "is this
 * PR green" without a second round trip. Naming a top-level field returns the
 * full object for it, which is why author/labels/assignees carry no {subfield}.
 */
export const PR_JSON = 'number,title,state,isDraft,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,url,body,additions,deletions,comments,labels,assignees,createdAt,updatedAt,statusCheckRollup'

/**
 * Fields for gh pr list: the columns of a PR table, nothing that costs a
 * second API call per row.
 */
export const PR_LIST_JSON = 'number,title,state,isDraft,headRefName,updatedAt,url,reviewDecision,baseRefName'

/**
 * Fields for gh run list. gh calls the branch headBranch; the contract calls
 * the data key branch, so it is renamed in mapRun.
 */
export const RUN_JSON = 'databaseId,name,displayTitle,headBranch,event,status,conclusion,createdAt,url,headSha'

/**
 * Fields for gh run view, with jobs and their steps inline: one call answers
 * "which job failed" for ciView, ciStatus and ciWatch. `jobs` alone already
 * carries steps, so no nested selection is needed (and none is possible).
 */
export const RUN_VIEW_JSON = 'databaseId,name,displayTitle,status,conclusion,url,workflowName,jobs'

/**
 * Fields for gh release view: a release with its assets. gh 2.92 rejects
 * isLatest here (`Unknown JSON field: "isLatest"` - verified against 2.92),
 * so which release is latest only comes from gh release list; mapRelease leaves
 * it null rather than guessing.
 */
export const RELEASE_JSON = 'tagName,name,isDraft,isPrerelease,publishedAt,url,body,assets'

/**
 * Fields for gh release list. gh 2.92 has neither url nor assets in
 * "gh release list --json", so the release page URL is composed from the tag in
 * mapRelease rather than read from the output - the one place this module does
 * not get a URL from gh.
 */
export const RELEASE_LIST_JSON = 'tagName,name,isLatest,isDraft,isPrerelease,publishedAt'

/**
 * Fields for gh issue view and gh issue list.
 */
export const ISSUE_JSON = 'number,title,state,url,updatedAt,author,labels,assignees,body,comments,createdAt,stateReason'

/** Fields for gh repo view, used to name the repo and its default branch. */
export const REPO_JSON = 'nameWithOwner,name,owner,url,defaultBranchRef,sshUrl'

/** The three argv shapes that mean "merge this way". */
export const MERGE_FLAGS = { squash: '--squash', merge: '--merge', rebase: '--rebase' }

/** What a caller must be told when a call needs an owner/repo it cannot find. */
export const NEED_REPO = '請傳 repo（owner/name 或 repo URL），或讓 git 端能從 path 的 remote 推出 owner/repo'

/** A line from an auth failure, as gh 2.92 words it. */
export const NEED_AUTH = '尚未登入 GitHub，請先跑 gh auth login（本工具不會替你登入）'

/** A line from a 404. */
export const NOT_FOUND = '找不到這個 repo（HTTP 404），請傳 repo（owner/name）確認無誤，或檢查 token 的存取範圍'

/**
 * Split a repo reference into { owner, repo }.
 *
 * Accepted shapes: owner/repo, https://host/owner/repo(.git),
 * git@host:owner/repo(.git), ssh://git@host/owner/repo, and a bare { owner, repo }
 * object. Anything else gives null so the caller can report the need for a
 * repo instead of guessing at an owner.
 *
 * @param {string | { owner?: string, repo?: string, name?: string } | null | undefined} value
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseRepoSlug(value) {
	if (value && typeof value === 'object') {
		const owner = String(value.owner ?? '').trim()
		const repo = String(value.repo ?? value.name ?? '').trim()
		if (owner === '' || repo === '') return null
		return { owner, repo: repo.replace(/\.git$/i, '') }
	}
	const text = String(value ?? '').trim()
	if (text === '') return null
	const withoutProtocol = text
		.replace(/^ssh:\/\/git@/i, '')
		.replace(/^git:\/\/git@/i, '')
		.replace(/^https?:\/\/(?:www\.)?github\.com[:/]/i, '')
		.replace(/^git@([^:]+):/i, '')
		.replace(/^github\.com[:/]/i, '')
	// A plain owner/name is already the path; only a leading slash needs going.
	const path = withoutProtocol.startsWith('/') ? withoutProtocol.slice(1) : withoutProtocol
	const parts = path.split('/').filter(part => part !== '')
	if (parts.length < 2) return null
	const owner = parts[0].replace(/\.git$/i, '')
	const repo = parts[1].replace(/\.git$/i, '')
	if (!/^[^\s/]+$/u.test(owner) || !/^[^\s/]+$/u.test(repo)) return null
	return { owner, repo }
}

/**
 * Build the --repo part of an argv, in the contract's priority order.
 *
 * Explicit repo wins; otherwise an owner/repo the caller discovered from git is
 * used; when allowCwd is set and nothing is known the command is sent without
 * --repo so gh can answer from the current directory. With allowCwd off - the
 * default - an unknown repo is an error, because silently letting gh guess would
 * act on whatever repository the working directory happens to point at.
 *
 * @param {object} [options]
 * @param {string | object} [options.repo] explicit owner/name, URL or { owner, repo }
 * @param {{ owner?: string, repo?: string } | null} [options.discovered] from gitInfo
 * @param {boolean} [options.allowCwd] let gh decide from cwd when nothing is known
 * @returns {{ ok: true, args: string[], slug: string | null, source: string } | { ok: false, error: string }}
 */
export function buildRepoFlag(options = {}) {
	const { repo, discovered, allowCwd = false } = options
	if (repo !== undefined && repo !== null && repo !== '') {
		const slug = parseRepoSlug(repo)
		if (slug === null) return { ok: false, error: '看不懂 repo：' + clip(String(repo), 60) + '。' + NEED_REPO }
		return { ok: true, args: ['--repo', slug.owner + '/' + slug.repo], slug: slug.owner + '/' + slug.repo, source: 'repo' }
	}
	const found = parseRepoSlug(discovered)
	if (found !== null) return { ok: true, args: ['--repo', found.owner + '/' + found.repo], slug: found.owner + '/' + found.repo, source: 'remote' }
	if (allowCwd) return { ok: true, args: [], slug: null, source: 'cwd' }
	return { ok: false, error: NEED_REPO }
}

/**
 * Turn one statusCheckRollup entry into { name, state, conclusion, url }.
 *
 * gh folds three different GitHub objects into that one array and each names
 * its parts differently: a check run gives name plus status plus detailsUrl, a
 * commit status gives context plus state plus targetUrl, a check suite gives
 * title plus workflowName plus status. This is the only place that knows those
 * shapes, so everything downstream - buckets, summaries, ciStatus - sees one
 * record. Vocabulary is canonicalised onto gh's own: state is the run status
 * (completed, in_progress, queued) and conclusion the verdict (success,
 * failure), which is what bucketOf reads. Unknown or empty entries become an
 * all-null record rather than being dropped, so a check the user can see on the
 * web is never invisible here.
 *
 * @param {unknown} entry one statusCheckRollup element
 * @returns {{ name: string|null, state: string|null, conclusion: string|null, url: string|null }}
 */
export function normaliseCheck(entry) {
	if (entry === null || typeof entry !== 'object') return { name: null, state: null, conclusion: null, url: null }
	const source = /** @type {Record<string, any>} */ (entry)
	const name = text(source.name ?? source.context ?? source.title ?? null) ?? workflowLabel(source.workflowName)
	const url = text(source.detailsUrl ?? source.targetUrl ?? source.url ?? null)
	const status = text(source.status ?? null)
	const conclusion = text(source.conclusion ?? null)
	if (status !== null) return { name, state: status.toLowerCase(), conclusion: lower(conclusion), url }
	const state = lower(text(source.state ?? null))
	if (state === null) return { name, state: null, conclusion: null, url }
	const contextResult = { success: 'success', failure: 'failure', error: 'failure', pending: null }
	const verdict = Object.prototype.hasOwnProperty.call(contextResult, state) ? contextResult[state] : null
	const contextStatus = state === 'pending' ? 'in_progress' : verdict === null ? null : 'completed'
	return { name, state: contextStatus, conclusion: verdict === null && state === 'pending' ? null : verdict, url }
}

/**
 * Normalise a whole rollup, an array of raw entries, or a PR object.
 *
 * @param {unknown} entries rollup array, single entry, or an object with statusCheckRollup
 * @returns {{ name: string|null, state: string|null, conclusion: string|null, url: string|null }[]}
 */
export function normaliseChecks(entries) {
	if (Array.isArray(entries)) return entries.map(entry => normaliseCheck(entry))
	if (entries !== null && typeof entries === 'object') {
		const rollup = /** @type {Record<string, any>} */ (entries).statusCheckRollup
		if (Array.isArray(rollup)) return rollup.map(entry => normaliseCheck(entry))
		return [normaliseCheck(entries)]
	}
	return []
}

/**
 * Flatten the checks of a PR (or of a run view) into reported rows.
 *
 * Each row is the contract's check: name, bucket, state, conclusion, url, plus
 * a job label when the source carries one (a run's job name), so prChecks can
 * say which job to look at.
 *
 * @param {unknown} source PR object, rollup array, or one entry
 * @param {{ job?: string | null }} [options] label to attach to every row
 * @returns {{ name: string|null, bucket: string, state: string|null, conclusion: string|null, url: string|null, job: string|null }[]}
 */
export function flattenChecks(source, options = {}) {
	return normaliseChecks(source).map(check => ({
		name: check.name,
		bucket: bucketOf(check.state, check.conclusion),
		state: check.state,
		conclusion: check.conclusion,
		url: check.url,
		job: text(options.job ?? (/** @type {any} */ (source)?.workflowName ?? null)),
	}))
}

/**
 * Reduce one gh run view document to the contract's run shape.
 *
 * Jobs keep their own bucket so a caller can point at the one that failed, and
 * steps are trimmed to name plus status plus conclusion - the log itself belongs
 * to ciLogs, not to a status answer.
 *
 * @param {unknown} raw one gh run view --json document
 * @param {{ failedOnly?: boolean }} [options] drop jobs that did not fail
 * @returns {{ id: string|null, name: string|null, status: string|null, conclusion: string|null, bucket: string, url: string|null, jobs: object[] }}
 */
export function summariseRun(raw, options = {}) {
	const run = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {})
	const jobs = (Array.isArray(run.jobs) ? run.jobs : []).map(job => summariseJob(job))
	return {
		id: text(run.databaseId ?? run.id ?? null),
		name: text(run.name ?? run.workflowName ?? null),
		status: text(run.status ?? null),
		conclusion: text(run.conclusion ?? null),
		bucket: bucketOf(run.status, run.conclusion),
		url: text(run.url ?? null),
		jobs: options.failedOnly === true ? jobs.filter(job => job.bucket === 'fail') : jobs,
	}
}

/**
 * One job of a run, with its steps bucketed the same way.
 *
 * @param {unknown} job
 * @returns {{ id: string|null, name: string|null, status: string|null, conclusion: string|null, bucket: string, url: string|null, steps: object[] }}
 */
export function summariseJob(job) {
	const source = /** @type {Record<string, any>} */ (job && typeof job === 'object' ? job : {})
	return {
		id: text(source.databaseId ?? source.id ?? null),
		name: text(source.name ?? null),
		status: text(source.status ?? null),
		conclusion: text(source.conclusion ?? null),
		bucket: bucketOf(source.status, source.conclusion),
		url: text(source.detailsUrl ?? source.url ?? null),
		steps: (Array.isArray(source.steps) ? source.steps : []).map(step => ({
			name: text(/** @type {any} */ (step)?.name ?? null),
			status: text(/** @type {any} */ (step)?.status ?? null),
			conclusion: text(/** @type {any} */ (step)?.conclusion ?? null),
			bucket: bucketOf(/** @type {any} */ (step)?.status, /** @type {any} */ (step)?.conclusion),
		})),
	}
}

/**
 * The jobs of a summarised run that a rerun would pick up.
 *
 * @param {{ jobs?: { name: string|null, bucket: string, url: string|null }[] }} run
 * @returns {{ job: string|null, url: string|null }[]}
 */
export function failingJobs(run) {
	return (run?.jobs ?? []).filter(job => job?.bucket === 'fail').map(job => ({ job: job.name, url: job.url }))
}

/**
 * One row of gh run list, in the contract's column names.
 *
 * @param {unknown} run
 * @returns {{ id: string|null, name: string|null, displayTitle: string|null, branch: string|null, event: string|null, status: string|null, conclusion: string|null, bucket: string, createdAt: string|null, url: string|null, headSha: string|null }}
 */
export function mapRun(run) {
	const source = /** @type {Record<string, any>} */ (run && typeof run === 'object' ? run : {})
	return {
		id: text(source.databaseId ?? source.id ?? null),
		name: text(source.name ?? null),
		displayTitle: text(source.displayTitle ?? null),
		branch: text(source.headBranch ?? source.branch ?? null),
		event: text(source.event ?? null),
		status: text(source.status ?? null),
		conclusion: text(source.conclusion ?? null),
		bucket: bucketOf(source.status, source.conclusion),
		createdAt: text(source.createdAt ?? null),
		url: text(source.url ?? null),
		headSha: text(source.headSha ?? null),
	}
}

/**
 * One release, in the contract's column names.
 *
 * @param {unknown} release
 * @param {{ url?: string | null }} [options] URL to use when gh gave none
 * @returns {{ tag: string|null, name: string|null, isLatest: boolean|null, isDraft: boolean|null, isPrerelease: boolean|null, publishedAt: string|null, url: string|null, body: string|null, assets: { name: string|null, size: number|null, url: string|null }[] }}
 */
export function mapRelease(release, options = {}) {
	const source = /** @type {Record<string, any>} */ (release && typeof release === 'object' ? release : {})
	return {
		tag: text(source.tagName ?? source.tag ?? null),
		name: text(source.name ?? null),
		isLatest: boolean(source.isLatest),
		isDraft: boolean(source.isDraft),
		isPrerelease: boolean(source.isPrerelease),
		publishedAt: text(source.publishedAt ?? null),
		url: text(source.url ?? options.url ?? null),
		body: text(source.body ?? null),
		assets: (Array.isArray(source.assets) ? source.assets : []).map(asset => ({
			name: text(/** @type {any} */ (asset)?.name ?? null),
			size: number(/** @type {any} */ (asset)?.size),
			url: text(/** @type {any} */ (asset)?.url ?? null),
		})),
	}
}

/**
 * Trim a gh run view --log dump.
 *
 * A full run log is tens of megabytes and no model should ever receive one, so
 * the tail is all that survives by default; the head of a log is setup noise and
 * the end is where the failure is. When the log carries gh's job headers - the
 * "run 1234 / job 5678 / job name /" prefix on every line - and the caller asks
 * for failing jobs only, lines from passing jobs are dropped before the tail is
 * taken, so 200 lines of tail means 200 lines of the jobs that matter and not
 * 200 lines of a successful setup job.
 *
 * @param {string | null | undefined} text the raw log
 * @param {object} [options]
 * @param {number} [options.tailLines] how many trailing lines to keep; 0 keeps all
 * @param {(string | { id?: string|null, name?: string|null })[] | null} [options.failingJobs] jobs to keep; null keeps every job
 * @returns {{ text: string, lines: number, truncated: boolean, filtered: boolean }}
 */
export function trimLog(text, options = {}) {
	const { tailLines = 200, failingJobs: wanted = null } = options
	const all = String(text ?? '').split(/\r?\n/u)
	let kept = all
	let filtered = false
	if (Array.isArray(wanted) && wanted.length > 0 && all.some(line => logJob(line) !== null)) {
		const names = new Set(wanted.map(entry => (typeof entry === 'object' && entry !== null ? String(entry.name ?? entry.id ?? '') : String(entry))).filter(line => line !== ''))
		const ids = new Set(wanted.map(entry => (typeof entry === 'object' && entry !== null ? String(entry.id ?? '') : '')).filter(line => line !== ''))
		kept = all.filter(line => {
			const found = logJob(line)
			if (found === null) return false
			return names.has(found.name) || (found.id !== null && ids.has(found.id))
		})
		filtered = kept.length !== all.length
	}
	const limit = Number.isFinite(tailLines) && Number(tailLines) > 0 ? Math.floor(Number(tailLines)) : 0
	const tail = limit > 0 ? kept.slice(Math.max(0, kept.length - limit)) : kept
	return { text: tail.join('\n'), lines: tail.length, truncated: tail.length !== all.length || filtered, filtered }
}

/**
 * Which job a line of gh's run log came from.
 *
 * @param {string} line
 * @returns {{ id: string|null, name: string } | null}
 */
export function logJob(line) {
	const found = /(?:^|[\t ])run\s+(\d+)\s*\/\s*job\s+(\d+)\s*\/\s*(.+?)\s*\//u.exec(String(line ?? ''))
	if (found === null) return null
	return { id: found[2], name: found[3] }
}

/**
 * The polling plan for ciWatch: how long, how often, how many times.
 *
 * Keeping this arithmetic in one pure function means the watcher's loop bound
 * and its reported numbers cannot disagree, and a test can assert the schedule
 * without a clock at all.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] how long to wait in total
 * @param {number} [options.intervalMs] how long between two looks
 * @returns {{ timeoutMs: number, intervalMs: number, polls: number }}
 */
export function pollPolicy(options = {}) {
	const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs ?? 300000)) || 0)
	const intervalMs = Math.max(1, Math.floor(Number(options.intervalMs ?? 10000)) || 1)
	return { timeoutMs, intervalMs, polls: Math.max(1, Math.ceil(timeoutMs / intervalMs) + 1) }
}

/**
 * The first http(s) URL in gh's output, kept whole.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function firstUrl(text) {
	const found = /https?:\/\/[^\s"')]+/u.exec(String(text ?? ''))
	return found === null ? null : found[0]
}

/**
 * A string field, or null where gh gave nothing, so a report prints a dash
 * instead of the word undefined.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
	if (value === undefined || value === null) return null
	const asText = typeof value === 'string' ? value : String(value)
	const trimmed = asText.trim()
	return trimmed === '' ? null : trimmed
}

/**
 * @param {string | null} value
 * @returns {string | null}
 */
function lower(value) {
	return value === null ? null : value.toLowerCase()
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function boolean(value) {
	if (value === undefined || value === null) return null
	return value === true || value === 'true'
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function number(value) {
	const asNumber = Number(value)
	return Number.isFinite(asNumber) ? asNumber : null
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function workflowLabel(value) {
	const label = text(value)
	return label === null ? null : label
}

/**
 * Repo flags go right after the subcommand, not at the end: gh reads a
 * positional (a tag, a run id, a release asset) by position, and a trailing
 * "--repo owner/name" would be taken as one more file argument.
 *
 * @param {string[]} args
 * @param {string[]} repoArgs
 * @returns {string[]}
 */
function withRepo(args, repoArgs) {
	if (repoArgs.length === 0) return args
	return [...args.slice(0, 2), ...repoArgs, ...args.slice(2)]
}

/**
 * The line this call ran, or would have run, quoted so it can be read back.
 *
 * @param {string[]} args
 * @returns {string}
 */
function commandText(args) {
	return ['gh', ...args].map(part => (/[\s"]/u.test(part) || part === '' ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Refuse to act, showing the line that would have acted.
 *
 * @param {string} command
 * @param {string} error
 * @returns {{ ok: false, needsConfirm: true, error: string, command: string }}
 */
function needsConfirm(command, error) {
	return { ok: false, needsConfirm: true, error, command }
}

/**
 * Turn a failed gh run into the contract's ok:false, naming the next step.
 *
 * gh words its failures for a human at a terminal, which is nearly the right
 * register here; what this adds is the GitHub-specific cases where the raw line
 * is not enough to act on: no credentials, no such repository, no pull request
 * on this branch, and a workflow that is already running.
 *
 * @param {any} result what the runner returned
 * @param {{ args?: string[], next?: string }} [options]
 * @returns {{ ok: false, error: string, command: string }}
 */
function ghFailure(result, options = {}) {
	const command = text(result?.command) ?? commandText(options.args ?? [])
	const haystack = [result?.stderr, result?.stdout, result?.error].map(part => String(part ?? '')).join(' ')
	const detail = firstLine(result?.stderr) || firstLine(result?.error) || firstLine(result?.stdout) || 'gh 沒有回傳內容'
	if (/^找不到 (?:gh|git)/u.test(String(result?.error ?? ''))) return { ok: false, error: redactSecrets(String(result.error)), command }
	if (result?.timedOut === true) return { ok: false, error: detail + '；下一步：稍後重試，或給這個工具更高的 timeoutMs', command }
	if (/http 401|gh auth login|requires authentication|bad credentials|authentication credentials/iu.test(haystack)) return { ok: false, error: NEED_AUTH, command }
	if (/http 403.*rate limit|secondary rate limit|abuse detection/iu.test(haystack)) return { ok: false, error: '觸發 GitHub 限流，稍後再重試（這輪先別連續打）', command }
	if (/http 404|not found|could not resolve host/iu.test(haystack) && !/pull request/iu.test(haystack)) return { ok: false, error: NOT_FOUND, command }
	if (/could not find pull request|no pull requests found|pull request not found/iu.test(haystack)) return { ok: false, error: '這個分支（或這個編號）沒有对应的 PR，請傳 branch 或 number', command }
	if (/already in progress|cannot rerun a run that is in progress|cannot be rerun|is still running/iu.test(haystack)) return { ok: false, error: '這個 workflow 已有執行中的 run，請先等它結束（要中止就用 gh run cancel <id>，屬高風險動作）', command }
	return { ok: false, error: detail + (options.next ? '；下一步：' + options.next : ''), command }
}

/**
 * The GitHub side of the bundle, built on the helpers above.
 *
 * Every method takes the same options bag - { path, repo, cwd } plus whatever
 * that action needs - and resolves to the contract's shape: { ok: true, ...data }
 * or { ok: false, error, command }. Destructive actions return needsConfirm
 * with the exact command line and run nothing.
 *
 * @param {{ run: (name: string, args: string[], options?: object) => Promise<object>, git?: Record<string, any>, settings?: Record<string, any> }} deps
 */
export function createGithub(deps) {
	const run = deps.run
	const git = deps.git ?? null
	const settings = deps.settings ?? {}

	/** One gh call. Never throws, never shells. */
	const gh = (args, options = {}) => run('gh', args, options)

	/** Where this call points: an explicit repo, the origin remote, or cwd. */
	const target = async options => {
		const explicit = options?.repo
		if (typeof explicit === 'string' && explicit.trim() !== '') return buildRepoFlag({ repo: explicit.trim() })
		if (git !== null && typeof git.remoteInfo === 'function') {
			const info = await git.remoteInfo({ path: options?.path, cwd: options?.cwd })
			if (info.ok === true) {
				const slug = parseRepoSlug(info.remoteUrl)
				if (slug !== null) return buildRepoFlag({ discovered: slug })
				// A real clone whose origin is not GitHub, or has none at all: gh
				// would fail the same way on every call, so explain instead of
				// spending a subprocess on it.
				return {
					ok: false,
					error: info.remoteUrl === null ? NEED_REPO + '（這個工作目錄的 git 沒有 origin 遠端）' : '這個 repo 的遠端不是 GitHub（' + info.remoteUrl + '），gh 動作要用明確的 repo。',
					next: '要打某個 GitHub repo 請傳 repo："owner/name"。',
				}
			}
		}
		// Not a git checkout we could read: let gh try the working directory itself.
		return buildRepoFlag({ allowCwd: true })
	}

	/** The branch gh should default to when the caller named none. */
	const ownBranch = async options => {
		const given = typeof options?.branch === 'string' && options.branch.trim() !== '' ? options.branch.trim() : null
		if (given !== null) return given
		if (git === null || typeof git.remoteInfo !== 'function') return null
		const info = await git.remoteInfo({ path: options?.path, cwd: options?.cwd })
		return info.ok === true && typeof info.branch === 'string' && info.branch !== '' ? info.branch : null
	}

	/** The directory gh should run in, so it can infer a repo with no --repo. */
	const directory = options => {
		const value = options?.path ?? options?.cwd
		return typeof value === 'string' && value.trim() !== '' ? value : undefined
	}

	/**
	 * A gh call whose stdout is JSON: repo flags, argv, then parse or explain.
	 * @param {string[]} args argv after the repo flags get appended
	 * @param {object} options { path, repo, cwd }
	 */
	const call = async (args, options = {}) => {
		const where = await target(options)
		if (where.ok !== true) return where
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args), next: options.next })
		const parsed = parseJson(result.stdout)
		if (parsed.ok !== true) return { ok: false, error: parsed.error, command: result.command ?? commandText([...args]) }
		return { ok: true, value: parsed.value, command: result.command ?? commandText(withRepo(args, where.args)), slug: where.slug }
	}

	/** A gh call whose answer is plain text (a URL, a diff, a log). */
	const callText = async (args, options = {}) => {
		const where = await target(options)
		if (where.ok !== true) return where
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: options.timeoutMs ?? settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args), next: options.next })
		return { ok: true, text: String(result.stdout ?? ''), command: result.command ?? commandText(withRepo(args, where.args)), slug: where.slug }
	}

	/** authStatus: who is logged in, on which host, with which scopes. */
	const authStatus = async options => {
		const status = await gh(['auth', 'status'], { cwd: directory(options), timeoutMs: settings.timeoutMs })
		const probe = String(status.stdout ?? '') + String(status.stderr ?? '')
		const ghVersion = /gh version (\S+)/.exec(probe)?.[1] ?? null
		if (status.ok !== true) {
			const version = await gh(['--version'], { cwd: directory(options) })
			return { ok: false, error: NEED_AUTH, command: 'gh auth status', ...(ghVersion === null && version.ok === true ? { ghVersion: firstLine(version.stdout) } : {}) }
		}
		const user = /account (\S+)/.exec(probe)?.[1] ?? /Logged in to \S+ account (\S+)/.exec(probe)?.[1] ?? null
		const host = /Logged in to (\S+)/.exec(probe)?.[1] ?? null
		const scopes = (/token scopes:?\s*:?\s*([^\n\r]+)/i.exec(probe)?.[1] ?? '').split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(part => part !== '')
		const data = { ok: true, user, host, scopes, ghVersion }
		if (git !== null && typeof git.version === 'function') data.gitVersion = await git.version()
		const where = await target(options)
		if (where.ok === true && where.slug !== null) data.repo = where.slug
		if (git !== null && typeof git.remoteInfo === 'function' && where.ok === true) {
			const info = await git.remoteInfo({ path: options?.path, cwd: options?.cwd })
			if (info.ok === true && info.branch !== null) data.branch = info.branch
		}
		return data
	}

	/** repoInfo: name, slug, default branch, URL - the identity of the target. */
	const repoInfo = async options => {
		// gh repo view has no --repo flag: the repository is the positional argument.
		const where = await target(options)
		if (where.ok !== true) return where
		const args = ['repo', 'view']
		if (typeof where.slug === 'string' && where.slug !== '') args.push(where.slug)
		args.push('--json', REPO_JSON)
		const result = await gh(args, { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args, next: options?.next })
		const parsed = parseJson(result.stdout)
		if (parsed.ok !== true) return { ok: false, error: parsed.error, command: result.command ?? commandText(args) }
		const value = parsed.value ?? {}
		return {
			ok: true,
			repo: value.nameWithOwner ?? where.slug ?? null,
			name: value.name ?? null,
			owner: value.owner?.name ?? null,
			defaultBranch: value.defaultBranchRef?.name ?? null,
			url: value.url ?? null,
			command: result.command ?? commandText(args),
		}
	}

	/** One PR record in the contract's names, checks bucketed. */
	const mapPr = raw => {
		const source = raw && typeof raw === 'object' ? raw : {}
		return {
			number: number(source.number),
			title: text(source.title),
			state: text(source.state),
			isDraft: source.isDraft === true,
			url: text(source.url),
			headRefName: text(source.headRefName),
			baseRefName: text(source.baseRefName),
			reviewDecision: text(source.reviewDecision),
			mergeable: text(source.mergeable),
			mergeStateStatus: text(source.mergeStateStatus),
			mergeQueueState: text(source.mergeQueueState),
			author: text(source.author?.login),
			labels: (Array.isArray(source.labels) ? source.labels : []).map(label => text(label?.name)).filter(Boolean),
			additions: number(source.additions),
			deletions: number(source.deletions),
			updatedAt: text(source.updatedAt),
			checks: flattenChecks(source.statusCheckRollup ?? []),
			body: text(source.body),
		}
	}

	/** The PR for a branch, or pr: null - "no PR" is a fact, not an error. */
	const prStatus = async options => {
		if (typeof options?.branch === 'string' && options.branch !== '') {
			const lookup = await call(['pr', 'list', '--head', options.branch, '--state', 'all', '--limit', '1', '--json', 'number'], options)
			if (lookup.ok !== true) return lookup
			const rows = Array.isArray(lookup.value) ? lookup.value : []
			if (rows.length === 0) return { ok: true, pr: null, command: lookup.command, note: 'branch ' + options.branch + ' 目前沒有 PR（開過又關掉的也會在這裡找到，所以是 null 而不是查錯）。' }
			return prView({ ...options, number: Number(rows[0].number) })
		}
		const result = await call(['pr', 'view', '--json', PR_JSON], options)
		if (result.ok !== true) {
			if (/沒有对应的 PR|could not find pull request|no pull requests found|no pull request for current branch/i.test(result.error)) return { ok: true, pr: null, command: result.command }
			return result
		}
		return { ok: true, pr: mapPr(result.value), command: result.command }
	}

	const prList = async options => {
		const args = ['pr', 'list', '--json', PR_LIST_JSON, '--state', text(options?.state) ?? 'open']
		const limit = clampCount(options?.limit, 50)
		args.push('--limit', String(limit))
		if (typeof options?.author === 'string' && options.author !== '') args.push('--author', options.author)
		if (Array.isArray(options?.labels) && options.labels.length > 0) args.push('--label', options.labels.join(','))
		const result = await call(args, options)
		if (result.ok !== true) return result
		return { ok: true, prs: (Array.isArray(result.value) ? result.value : []).map(entry => mapPr(entry)), command: result.command }
	}

	const prView = async options => {
		if (options?.number === undefined) return prStatus(options)
		const result = await call(['pr', 'view', String(options.number), '--json', PR_JSON + ',files,comments'], options)
		if (result.ok !== true) return result
		const pr = mapPr(result.value)
		const comments = (Array.isArray(result.value?.comments) ? result.value.comments : []).map(comment => ({ author: { login: comment?.author?.login ?? null }, body: comment?.body ?? '', createdAt: comment?.createdAt ?? null }))
		return { ok: true, pr, files: (Array.isArray(result.value?.files) ? result.value.files : []).map(file => ({ path: file?.path ?? null, additions: number(file?.additions), deletions: number(file?.deletions), status: text(file?.status) })), comments, command: result.command }
	}

	/** Inline review comments, which live apart from the PR conversation. */
	const prReviewComments = async options => {
		if (options?.number === undefined) return { ok: false, error: '要看 review 留言請給 number' }
		const result = await call(['api', '/repos/{owner}/{repo}/pulls/' + options.number + '/comments', '--paginate', '--jq', '.'], options)
		if (result.ok !== true) return result
		const rows = Array.isArray(result.value) ? result.value : []
		return {
			ok: true,
			comments: rows.map(row => ({
				id: row?.id ?? null,
				inReplyToId: row?.in_reply_to_id ?? null,
				author: { login: row?.user?.login ?? null },
				body: row?.body ?? '',
				path: row?.path ?? null,
				line: row?.line ?? row?.original_line ?? null,
				commitId: row?.commit_id ?? null,
			})),
			command: result.command,
		}
	}

	/** The PR's own diff, parsed into per-file counts because gh has no numstat. */
	const prDiff = async options => {
		if (options?.number === undefined) return { ok: false, error: '要看 PR diff 請給 number' }
		const result = await callText(['pr', 'diff', String(options.number)], options)
		if (result.ok !== true) return result
		const patch = result.text
		return { ok: true, range: 'PR #' + options.number, files: patchFiles(patch), patch: clip(patch, options?.maxChars ?? 6000), command: result.command }
	}

	const prCreate = async options => {
		const title = text(options?.title)
		if (title === null) return { ok: false, error: '開 PR 需要 title' }
		const args = ['pr', 'create', '--title', title]
		if (options?.body !== undefined && options.body !== null) args.push('--body', String(options.body))
		if (typeof options?.base === 'string' && options.base !== '') args.push('--base', options.base)
		if (typeof options?.head === 'string' && options.head !== '') args.push('--head', options.head)
		if (options?.draft === true) args.push('--draft')
		if (options?.deleteBranch === true) args.push('--delete-branch')
		if (Array.isArray(options?.assignees) && options.assignees.length > 0) args.push('--assignee', options.assignees.join(','))
		const result = await callText(args, options)
		if (result.ok !== true) return result
		const url = firstUrl(result.text)
		return { ok: true, number: url === null ? null : Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN) || undefined, url: url ?? undefined, command: result.command }
	}

	const prUpdate = async options => {
		if (options?.number === undefined) return { ok: false, error: '改 PR 需要 number' }
		const args = ['pr', 'edit', String(options.number)]
		if (typeof options?.title === 'string' && options.title !== '') args.push('--title', options.title)
		if (options?.body !== undefined && options.body !== null) args.push('--body', String(options.body))
		if (typeof options?.base === 'string' && options.base !== '') args.push('--base', options.base)
		if (Array.isArray(options?.labels) && options.labels.length > 0) args.push('--add-label', options.labels.join(','))
		if (args.length === 2) return { ok: false, error: '沒有要改的東西：給 title、body、base 或 labels 其中之一。' }
		const result = await callText(args, options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, url: firstUrl(result.text) ?? undefined, changed: [options?.title !== undefined ? 'title' : null, options?.body !== undefined ? 'body' : null, options?.base !== undefined ? 'base' : null].filter(Boolean), command: result.command }
	}

	const prComment = async options => {
		if (options?.number === undefined) return { ok: false, error: '留言需要 number' }
		const body = text(options?.body)
		if (body === null) return { ok: false, error: '留言需要 body' }
		const result = await callText(['pr', 'comment', String(options.number), '--body', body], options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, url: firstUrl(result.text) ?? undefined, command: result.command }
	}

	/**
	 * Reply to a review comment. commentId is a comment id for a reply and a
	 * thread id for resolve - the two are different objects on GitHub, and gh
	 * keeps them apart, so the error says which one was needed.
	 */
	const prReply = async options => {
		if (options?.number === undefined || typeof options?.body !== 'string' || options.body === '') return { ok: false, error: '回覆需要 number 與 body' }
		if (options?.resolve === true) {
			if (typeof options?.commentId !== 'number' && typeof options?.commentId !== 'string') return { ok: false, error: 'resolve 需要 commentId（review thread 的 id，可用 action=comments 拿到）' }
			const query = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: "' + String(options.commentId) + '" }) { thread { isResolved } } }'
			const result = await call(['api', 'graphql', '-f', 'query=' + query], options)
			if (result.ok !== true) return result
			return { ok: true, number: options.number, note: 'thread 已標為 resolved。', command: result.command }
		}
		if (typeof options?.commentId !== 'number') return { ok: false, error: '回覆某條 review 留言需要 commentId（number）。要一般留言請用 action=comment。' }
		const result = await callText(['pr', 'review', '--comment', '--number', String(options.number), '--body', options.body], options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, note: '已回覆 comment ' + options.commentId + '。', command: result.command }
	}

	const prCheckout = async options => {
		if (options?.number === undefined) return { ok: false, error: 'checkout PR 需要 number' }
		const args = ['pr', 'checkout', String(options.number)]
		if (typeof options?.branch === 'string' && options.branch !== '') args.push('--branch-name', options.branch)
		const where = await target(options)
		if (where.ok !== true) return where
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args) })
		return { ok: true, note: firstLine(result.stdout) || firstLine(result.stderr) || ('已切到 PR #' + options.number), command: result.command }
	}

	const prReady = async options => {
		if (options?.number === undefined) return { ok: false, error: 'mark ready 需要 number' }
		const result = await callText(['pr', 'ready', String(options.number)], options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, note: '已轉成 ready for review。', command: result.command }
	}

	/**
	 * Merge, with the gate in front: an auto-merge request is queued, but an
	 * actual merge of someone's work needs confirm:true in the same call.
	 */
	const prMerge = async options => {
		if (options?.number === undefined) return { ok: false, error: 'merge 需要 number' }
		const strategy = MERGE_FLAGS[options?.strategy] !== undefined ? options.strategy : 'squash'
		const args = ['pr', 'merge', String(options.number), MERGE_FLAGS[strategy]]
		if (options?.deleteBranch === true) args.push('--delete-branch')
		if (options?.auto === true) args.push('--auto')
		const where = await target(options)
		if (where.ok !== true) return where
		const command = 'gh ' + withRepo(args, where.args).map(part => (/[\s"]/u.test(part) ? JSON.stringify(part) : part)).join(' ')
		if (options?.auto !== true && options?.confirm !== true) {
			return needsConfirm(command, '這會把 PR #' + options.number + ' 用 ' + strategy + ' 真的合併進 ' + (options?.base ?? 'base 分支') + '。確認請帶 confirm:true 重呼；只想排進 auto-merge 請給 auto:true。')
		}
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args), next: '先 repo_ci 看檢查有沒有紅，或 repo_pr action=ready 確認不是 draft' })
		return { ok: true, number: options.number, note: options?.auto === true ? '已排進 auto-merge，條件齊全時 GitHub 會自己合併。' : '已以 ' + strategy + ' 合併。', command }
	}

	/** The checks of one PR - the question 'is it green' answered directly. */
	const prChecks = async options => {
		const view = await prView(options)
		if (view.ok !== true) return view
		return { ok: true, number: view.pr?.number ?? options?.number, checks: view.pr?.checks ?? [], command: view.command }
	}

	/** The latest runs - 'is my work green right now'. */
	const ciStatus = async options => {
		const args = ['run', 'list', '--json', RUN_JSON, '--limit', '15']
		// "status" means THIS branch's runs; with no branch named, ask git which
		// one that is rather than listing the whole repo's history.
		const branch = await ownBranch(options)
		if (branch !== null) args.push('--branch', branch)
		if (typeof options?.workflow === 'string' && options.workflow !== '') args.push('--workflow', options.workflow)
		const result = await call(args, options)
		if (result.ok !== true) return result
		const runs = (Array.isArray(result.value) ? result.value : []).map(entry => mapRun(entry))
		const failing = runs.filter(entry => entry.bucket === 'fail').map(entry => ({ runId: entry.id, name: entry.name, job: null }))
		return { ok: true, runs, failing, command: result.command }
	}

	const ciList = async options => {
		const args = ['run', 'list', '--json', RUN_JSON, '--limit', String(clampCount(options?.limit, 50))]
		if (typeof options?.branch === 'string' && options.branch !== '') args.push('--branch', options.branch)
		if (typeof options?.workflow === 'string' && options.workflow !== '') args.push('--workflow', options.workflow)
		if (options?.includeAll === true) args.push('--all')
		const result = await call(args, options)
		if (result.ok !== true) return result
		return { ok: true, runs: (Array.isArray(result.value) ? result.value : []).map(entry => mapRun(entry)), command: result.command }
	}

	const ciView = async options => {
		if (options?.runId === undefined) return { ok: false, error: '要看某個 run 請給 runId（repo_ci action=list 可拿到）' }
		const result = await call(['run', 'view', String(options.runId), '--json', RUN_VIEW_JSON], options)
		if (result.ok !== true) return result
		const run = summariseRun(result.value)
		return { ok: true, run: { ...run, databaseId: run.id, displayTitle: text(result.value?.displayTitle) }, command: result.command }
	}

	/** A run's log, tail-trimmed: a full log is megabytes and never useful whole. */
	const ciLogs = async options => {
		if (options?.runId === undefined) return { ok: false, error: '要看 log 請給 runId' }
		const args = ['run', 'view', String(options.runId)]
		if (options?.failedOnly !== false) args.push('--log-failed')
		else args.push('--log')
		if (options?.job !== undefined) args.push('--job', String(options.job))
		const where = await target(options)
		if (where.ok !== true) return where
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: options?.timeoutMs ?? Math.max(settings.timeoutMs ?? 60000, 120000) })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args), next: 'run 可能還在跑或已過期（log 只留 90 天）' })
		const trimmed = trimLog(result.stdout, { tailLines: clampCount(options?.tailLines, 1000, 200), failingJobs: options?.failedOnly !== false ? null : null })
		const view = await ciView({ ...options, runId: options.runId })
		return {
			ok: true,
			run: view.ok === true ? view.run : { databaseId: options.runId },
			logs: trimmed.text,
			notes: [trimmed.truncated ? 'log 已取尾端 ' + trimmed.lines + ' 行（原始更長）' : null, options?.failedOnly !== false ? '只含失敗 job（failedOnly:false 取全部）' : null].filter(Boolean),
			command: result.command,
		}
	}

	/**
	 * Wait for a run to finish by polling. Deliberately not 'gh run watch': that
	 * streams a whole log through the conversation, which is what a model must
	 * not receive. The answer is the verdict plus how long it took.
	 */
	const ciWatch = async options => {
		if (options?.runId === undefined) return { ok: false, error: 'watch 需要 runId' }
		const policy = pollPolicy({ timeoutMs: options?.timeoutMs ?? settings.watchTimeoutMs ?? 300000, intervalMs: options?.intervalMs ?? settings.watchIntervalMs ?? 10000 })
		const startedAt = Date.now()
		let last = null
		for (let poll = 0; poll < policy.polls; poll += 1) {
			const view = await ciView({ ...options, runId: options.runId })
			if (view.ok !== true) return view
			last = view.run
			if (isTerminal(last.status)) break
			await sleep(Math.min(policy.intervalMs, Math.max(0, policy.timeoutMs - (Date.now() - startedAt))))
		}
		const waitedMs = Date.now() - startedAt
		const timedOut = last !== null && !isTerminal(last.status)
		return {
			ok: true,
			runId: options.runId,
			status: last?.status ?? null,
			conclusion: last?.conclusion ?? null,
			bucket: last?.bucket ?? 'unknown',
			url: last?.url ?? null,
			waitedMs,
			...(timedOut ? { timedOut: true } : {}),
			command: 'gh run view ' + options.runId,
		}
	}

	/** Rerun a workflow: failed jobs by default, and gated like any write. */
	const ciRerun = async options => {
		if (options?.runId === undefined) return { ok: false, error: 'rerun 需要 runId' }
		const args = ['run', 'rerun', String(options.runId)]
		if (options?.failedOnly !== false) args.push('--failed')
		else args.push('--rerun-timings')
		const where = await target(options)
		if (where.ok !== true) return where
		const command = 'gh ' + withRepo(args, where.args).map(part => (/[\s"]/u.test(part) ? JSON.stringify(part) : part)).join(' ')
		if (options?.confirm !== true) return needsConfirm(command, '這會重新執行 run ' + options.runId + (options?.failedOnly !== false ? ' 的失敗 job' : '（全部 job）') + '，會花 CI 額度也可能重發通知。確認請帶 confirm:true。')
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args) })
		return { ok: true, note: '已重新排入 CI；用 repo_ci action=watch 附 runId 等結果。', command }
	}

	const workflowList = async options => {
		const result = await call(['workflow', 'list', '--json', 'id,name,state,path', '--limit', String(clampCount(options?.limit, 100))], options)
		if (result.ok !== true) return result
		return { ok: true, workflows: (Array.isArray(result.value) ? result.value : []).map(entry => ({ id: entry?.id ?? null, name: text(entry?.name), state: text(entry?.state), path: text(entry?.path) })), command: result.command }
	}

	const workflowRun = async options => {
		const id = text(options?.workflow ?? options?.runId)
		if (id === null) return { ok: false, error: '觸發 workflow 需要 workflow（id 或名稱）' }
		const args = ['workflow', 'run', String(id)]
		if (typeof options?.ref === 'string' && options.ref !== '') args.push('--ref', options.ref)
		for (const [key, value] of Object.entries(options?.inputs ?? {})) args.push('-f', key + '=' + String(value))
		const where = await target(options)
		if (where.ok !== true) return where
		const command = 'gh ' + withRepo(args, where.args).map(part => (/[\s"]/u.test(part) ? JSON.stringify(part) : part)).join(' ')
		if (options?.confirm !== true) return needsConfirm(command, '這會手動觸發 workflow「' + id + '」，會花 CI 額度、可能部署東西。確認請帶 confirm:true。')
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args) })
		return { ok: true, note: '已觸發；用 repo_ci action=list 看新的 run。', command }
	}

	/** Issues. */
	const mapIssue = raw => {
		const source = raw && typeof raw === 'object' ? raw : {}
		return {
			number: number(source.number),
			title: text(source.title),
			state: text(source.state),
			stateReason: text(source.stateReason),
			url: text(source.url),
			updatedAt: text(source.updatedAt),
			author: text(source.author?.login),
			labels: (Array.isArray(source.labels) ? source.labels : []).map(label => text(label?.name)).filter(Boolean),
			body: text(source.body),
		}
	}

	const issueList = async options => {
		const args = ['issue', 'list', '--json', ISSUE_JSON.replace(',comments', ',comments'), '--state', text(options?.state) ?? 'open', '--limit', String(clampCount(options?.limit, 50))]
		if (typeof options?.assignee === 'string' && options.assignee !== '') args.push('--assignee', options.assignee)
		if (Array.isArray(options?.labels) && options.labels.length > 0) args.push('--label', options.labels.join(','))
		if (typeof options?.search === 'string' && options.search !== '') args.push('--search', options.search)
		const result = await call(args, options)
		if (result.ok !== true) return result
		return { ok: true, issues: (Array.isArray(result.value) ? result.value : []).map(entry => mapIssue(entry)), command: result.command }
	}

	const issueView = async options => {
		if (options?.number === undefined) return { ok: false, error: '看單條 issue 需要 number' }
		const result = await call(['issue', 'view', String(options.number), '--json', ISSUE_JSON + ',comments'], options)
		if (result.ok !== true) return result
		const comments = (Array.isArray(result.value?.comments) ? result.value.comments : []).map(comment => ({ author: { login: comment?.author?.login ?? null }, body: comment?.body ?? '', createdAt: comment?.createdAt ?? null }))
		return { ok: true, issue: mapIssue(result.value), comments, command: result.command }
	}

	const issueCreate = async options => {
		const title = text(options?.title)
		if (title === null) return { ok: false, error: '開 issue 需要 title' }
		const args = ['issue', 'create', '--title', title]
		if (options?.body !== undefined && options.body !== null) args.push('--body', String(options.body))
		if (Array.isArray(options?.labels) && options.labels.length > 0) args.push('--label', options.labels.join(','))
		if (Array.isArray(options?.assignees) && options.assignees.length > 0) args.push('--assignee', options.assignees.join(','))
		const result = await callText(args, options)
		if (result.ok !== true) return result
		const url = firstUrl(result.text)
		return { ok: true, number: Number(/\/issues\/(\d+)/.exec(url ?? '')?.[1] ?? NaN) || undefined, url: url ?? undefined, command: result.command }
	}

	const issueComment = async options => {
		if (options?.number === undefined || typeof options?.body !== 'string' || options.body === '') return { ok: false, error: '留言需要 number 與 body' }
		const result = await callText(['issue', 'comment', String(options.number), '--body', options.body], options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, url: firstUrl(result.text) ?? undefined, command: result.command }
	}

	const issueSetState = async options => {
		if (options?.number === undefined) return { ok: false, error: '改 issue 狀態需要 number' }
		const state = options?.state === 'open' ? 'open' : 'closed'
		const result = await callText(['issue', 'edit', String(options.number), '--state', state], options)
		if (result.ok !== true) return result
		return { ok: true, number: options.number, note: 'issue 已轉為 ' + state + '。', command: result.command }
	}

	/** Releases. */
	const releaseList = async options => {
		const result = await call(['release', 'list', '--json', RELEASE_LIST_JSON, '--limit', String(clampCount(options?.limit, 50))], options)
		if (result.ok !== true) return result
		return { ok: true, releases: (Array.isArray(result.value) ? result.value : []).map(entry => mapRelease(entry)), assetsKnown: false, command: result.command }
	}

	const releaseView = async options => {
		const args = ['release', 'view', '--json', RELEASE_JSON]
		if (typeof options?.tag === 'string' && options.tag !== '') args.push(options.tag)
		const result = await call(args, options)
		if (result.ok !== true) return result
		return { ok: true, release: mapRelease(result.value), assetsKnown: true, command: result.command }
	}

	const releaseCreate = async options => {
		const tag = text(options?.tag)
		if (tag === null) return { ok: false, error: '發 release 需要 tag（例 v0.1.0）' }
		const args = ['release', 'create', tag]
		if (typeof options?.name === 'string' && options.name !== '') args.push('--title', options.name)
		if (typeof options?.body === 'string' && options.body !== '') args.push('--notes', options.body)
		if (options?.generateNotes === true && (options?.body === undefined || options?.body === null || options?.body === '')) args.push('--generate-notes')
		if (options?.draft === true) args.push('--draft')
		if (options?.prerelease === true) args.push('--prerelease')
		if (options?.latest === false) args.push('--latest=false')
		if (typeof options?.target === 'string' && options.target !== '') args.push('--target', options.target)
		for (const asset of Array.isArray(options?.assets) ? options.assets : []) args.push(String(asset))
		const result = await callText(args, options)
		if (result.ok !== true) return result
		return { ok: true, tag, url: firstUrl(result.text) ?? undefined, note: (Array.isArray(options?.assets) && options.assets.length > 0 ? '已上傳 ' + options.assets.length + ' 個附檔。' : undefined), command: result.command }
	}

	const releaseEdit = async options => {
		const tag = text(options?.tag)
		if (tag === null) return { ok: false, error: '改 release 需要 tag' }
		const args = ['release', 'edit', tag]
		if (typeof options?.name === 'string' && options.name !== '') args.push('--title', options.name)
		if (typeof options?.body === 'string' && options.body !== '') args.push('--notes', options.body)
		if (options?.draft === true) args.push('--draft')
		if (options?.draft === false) args.push('--draft=false')
		if (options?.prerelease === true) args.push('--prerelease')
		if (args.length === 3) return { ok: false, error: '沒有要改的東西：給 name、body 或 draft 其中之一。' }
		const result = await callText(args, options)
		if (result.ok !== true) return result
		return { ok: true, tag, url: firstUrl(result.text) ?? undefined, command: result.command }
	}

	const releaseDelete = async options => {
		const tag = text(options?.tag)
		if (tag === null) return { ok: false, error: '刪 release 需要 tag' }
		const where = await target(options)
		if (where.ok !== true) return where
		const args = ['release', 'delete', tag, '--yes']
		const command = 'gh ' + withRepo(args, where.args).map(part => (/[\s"]/u.test(part) ? JSON.stringify(part) : part)).join(' ')
		if (options?.confirm !== true) return needsConfirm(command, '這會刪掉 release ' + tag + '（tag 本身會留著，附檔會不見）。確認請帶 confirm:true。')
		const result = await gh(withRepo(args, where.args), { cwd: directory(options), timeoutMs: settings.timeoutMs })
		if (result.ok !== true) return ghFailure(result, { args: withRepo(args, where.args) })
		return { ok: true, tag, note: 'release 已刪（本地與遠端的 tag 沒有動）。', command }
	}

	return {
		authStatus, repoInfo,
		prStatus, prList, prView, prCreate, prUpdate, prComment, prReply, prReviewComments, prDiff, prCheckout, prReady, prMerge, prChecks,
		ciStatus, ciList, ciView, ciLogs, ciWatch, ciRerun, workflowList, workflowRun,
		issueList, issueView, issueCreate, issueComment, issueSetState,
		releaseList, releaseView, releaseCreate, releaseEdit, releaseDelete,
	}
}

/** A list limit inside what gh accepts in one round trip. */
function clampCount(value, max, fallback = 20) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(1, Math.trunc(number)))
}

/**
 * Per-file counts read out of a unified patch, because gh has no --numstat.
 *
 * Only the hunk body is counted (a line starting with a single space or +/-),
 * so a line of context that happens to begin with '+' in the file text cannot
 * be miscounted: hunk bodies are exactly +/-/space at column one.
 *
 * @param {string} patch the output of gh pr diff
 * @returns {{ path: string, additions: number, deletions: number, status: string }[]}
 */
export function patchFiles(patch) {
	const rows = []
	let current = null
	for (const line of String(patch ?? '').split(/\r?\n/)) {
		const header = /^diff --git a\/(\S+) b\/(\S+)/u.exec(line)
		if (header !== null) {
			if (current !== null) rows.push(current)
			current = { path: header[2], additions: 0, deletions: 0, status: 'modified' }
			continue
		}
		if (current === null) continue
		if (line.startsWith('new file mode')) current.status = 'added'
		else if (line.startsWith('deleted file mode')) current.status = 'deleted'
		else if (line.startsWith('Binary files')) current.status = 'binary'
		else if (line.startsWith('rename to ')) current.status = 'renamed'
		else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
		else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
	}
	if (current !== null) rows.push(current)
	return rows
}

/** Await a while, used by ciWatch's polling loop. */
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
