/**
 * One table for CI verdicts, shared by the renderer and the data layer.
 *
 * lib/format.js turns a CI status into a marker string for a human-looking
 * report; a tool that has to decide something (is this branch green? which run
 * should be rerun?) needs the same judgement as a value, not a string with
 * padding in it. bucketOf is that value: the table below is written once and
 * checkMark in lib/format.js is the same mapping rendered as a marker, so the
 * two can never disagree about whether a run passed.
 *
 * The six buckets are the whole vocabulary of the contract:
 * pass, fail, pending, skipped, neutral, unknown.
 *
 * @module dsh-repo-ops/bucket
 */

/** Bucket values, in the order a report lists them. */
export const BUCKET_ORDER = ['pass', 'fail', 'pending', 'skipped', 'neutral', 'unknown']

/** Run statuses that mean "this run will not change any more". */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired']

/** Statuses that mean "GitHub has not decided yet". */
const PENDING_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested', 'action_required']

/** Conclusions that count as green. */
const PASSING = ['success', 'passed']

/** Conclusions that are final but are nobody's fault. */
const SKIPPABLE = ['skipped', 'neutral', 'cancelled', 'action_required']

/** Conclusions that are final and red. */
const FAILING = ['failure', 'timed_out', 'startup_failure', 'stale', 'error']

/**
 * The bucket for one CI entry: the same judgement checkMark renders as a marker.
 *
 * GitHub splits a check into a status (where it is in its life: queued,
 * in_progress, completed) and a conclusion (what it decided: success, failure,
 * skipped). Anything still running is pending whatever the conclusion says; a
 * completed entry is judged by its conclusion alone. An entry with neither -
 * which does happen when gh omits a field - is unknown, never silently green.
 *
 * @param {string | null | undefined} status e.g. completed, queued, in_progress
 * @param {string | null | undefined} conclusion e.g. success, failure, skipped
 * @returns {'pass'|'fail'|'pending'|'skipped'|'neutral'|'unknown'}
 */
export function bucketOf(status, conclusion) {
	const state = String(status ?? '').toLowerCase()
	const result = String(conclusion ?? '').toLowerCase()
	if (state !== 'completed') {
		if (state === '') return result === '' ? 'unknown' : guessFromConclusion(result)
		if (PENDING_STATUSES.includes(state)) return 'pending'
		if (TERMINAL_STATUSES.includes(state)) return result === '' ? 'neutral' : guessFromConclusion(result)
		return 'unknown'
	}
	if (PASSING.includes(result)) return 'pass'
	if (FAILING.includes(result)) return 'fail'
	if (SKIPPABLE.includes(result)) return 'skipped'
	if (result === '') return 'neutral'
	return 'fail'
}

/**
 * Judge an entry that carries a conclusion but no status.
 *
 * @param {string} result lowercased conclusion
 * @returns {'pass'|'fail'|'pending'|'skipped'|'neutral'|'unknown'}
 */
function guessFromConclusion(result) {
	if (PASSING.includes(result)) return 'pass'
	if (FAILING.includes(result)) return 'fail'
	if (SKIPPABLE.includes(result)) return 'skipped'
	if (PENDING_STATUSES.includes(result)) return 'pending'
	return 'unknown'
}

/**
 * Has this run finished, whatever it decided?
 *
 * A conclusion of its own is decisive: some API shapes report a terminal status
 * only through the conclusion field.
 *
 * @param {string | null | undefined} status
 * @param {string | null | undefined} [conclusion]
 * @returns {boolean}
 */
export function isTerminal(status, conclusion) {
	const state = String(status ?? '').toLowerCase()
	const result = String(conclusion ?? '').toLowerCase()
	if (result !== '' && result !== 'null') return true
	if (TERMINAL_STATUSES.includes(state)) return true
	return state === '' ? false : !PENDING_STATUSES.includes(state) && TERMINAL_STATUSES.includes(state)
}

/**
 * The terminal status words, for callers that want to print the rule.
 *
 * @returns {string[]}
 */
export function terminalStatuses() {
	return [...TERMINAL_STATUSES]
}

/**
 * Count a list of checks by bucket, for a one-line summary.
 *
 * @param {{ status?: string|null, conclusion?: string|null }[]} checks
 * @returns {Record<string, number>}
 */
export function tallyBuckets(checks) {
	const counts = {}
	for (const name of BUCKET_ORDER) counts[name] = 0
	for (const check of checks ?? []) {
		const bucket = bucketOf(check?.status ?? check?.state, check?.conclusion)
		counts[bucket] = (counts[bucket] ?? 0) + 1
	}
	return counts
}
