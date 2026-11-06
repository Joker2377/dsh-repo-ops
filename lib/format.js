/**
 * Text rendering for tool output.
 *
 * A tool's return value is read by a model, not parsed by a program, so this
 * module's job is density without ambiguity: aligned columns, one fact per
 * line, and a marker word instead of a colour. No emoji, no progress bars, and
 * never a raw JSON dump - a JSON blob costs twice the tokens for the same
 * information.
 *
 * @module dsh-repo-ops/format
 */

import { clip } from './cli.js'

/** Markers used for CI and review state. Words, so they survive copy-paste. */
export const MARK = {
	pass: '[PASS]',
	fail: '[FAIL]',
	pending: '[WAIT]',
	skipped: '[SKIP]',
	neutral: '[--  ]',
	unknown: '[?   ]',
}

/**
 * One "key: value" line per defined field; empty fields are left out rather
 * than printed as "null", which the model would read as a fact.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function fields(fields) {
	const lines = []
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null || value === '') continue
		if (Array.isArray(value)) {
			if (value.length === 0) continue
			lines.push(key + ': ' + value.join(', '))
			continue
		}
		if (typeof value === 'boolean') {
			lines.push(key + ': ' + (value ? 'yes' : 'no'))
			continue
		}
		lines.push(key + ': ' + String(value))
	}
	return lines.join('\n')
}

/**
 * Fixed-width text table.
 *
 * Column specs are { key, label, width?, align? }. Values are stringified,
 * newlines flattened to one line, and each cell trimmed to its column width so
 * a long commit subject cannot push the table off screen. A row that has more
 * columns than the table is truncated; nothing wraps.
 *
 * @param {{ key: string, label?: string, width?: number, align?: 'left' | 'right' }[]} columns
 * @param {Record<string, unknown>[]} rows
 * @param {object} [options]
 * @param {boolean} [options.header]
 * @returns {string}
 */
export function table(columns, rows, options = {}) {
	const showHeader = options.header !== false
	const widths = columns.map(column => column.width ?? Math.max(
		showHeader ? String(column.label ?? column.key).length : 0,
		...rows.map(row => cellText(row?.[column.key]).length),
	))
	const render = cells => cells.map((cell, index) => {
		const column = columns[index]
		const text = truncate(cell, widths[index])
		return column?.align === 'right' ? text.padStart(widths[index]) : text.padEnd(widths[index])
	}).join('  ').trimEnd()
	const lines = []
	if (showHeader) lines.push(render(columns.map(column => String(column.label ?? column.key))))
	for (const row of rows) lines.push(render(columns.map(column => cellText(row?.[column.key]))))
	return lines.join('\n')
}

function cellText(value) {
	if (value === undefined || value === null) return '-'
	if (typeof value === 'boolean') return value ? 'yes' : 'no'
	if (Array.isArray(value)) return value.join(',')
	return String(value).replace(/\s*\r?\n\s*/g, ' ').trim()
}

function truncate(text, width) {
	if (text.length <= width) return text
	return width <= 1 ? text.slice(0, Math.max(1, width)) : text.slice(0, width - 1) + '…'
}

/**
 * A titled block, so one tool result can carry several sections.
 *
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function section(title, body) {
	const text = String(body ?? '').trimEnd()
	if (text === '') return title + ':\n(nothing)'
	return title + ':\n' + text
}

/**
 * Bullet lines with a hanging indent, for lists of nested facts.
 *
 * @param {string[]} items
 * @returns {string}
 */
export function bullets(items) {
	return (items ?? []).map(item => '- ' + String(item).replace(/\n/g, '\n  ')).join('\n')
}

/**
 * Map CI status plus conclusion onto one marker.
 *
 * @param {string | undefined} status e.g. completed, queued, in_progress
 * @param {string | undefined} conclusion e.g. success, failure, cancelled
 * @returns {string}
 */
export function checkMark(status, conclusion) {
	const state = String(status ?? '').toLowerCase()
	const result = String(conclusion ?? '').toLowerCase()
	if (state !== 'completed') {
		if (state === '' && result === '') return MARK.unknown
		if (state === 'queued' || state === 'in_progress' || state === 'waiting' || state === 'pending' || state === 'requested') return MARK.pending
		return MARK.unknown
	}
	if (result === 'success' || result === 'passed') return MARK.pass
	if (result === '' ) return MARK.neutral
	if (result === 'skipped' || result === 'neutral' || result === 'cancelled' || result === 'action_required') return MARK.skipped
	if (result === 'timed_out' || result === 'startup_failure') return MARK.fail
	return MARK.fail
}

/**
 * Summarise a list of check results as counts, the thing a model acts on.
 *
 * @param {{ status?: string, conclusion?: string }[]} checks
 * @returns {string}
 */
export function checkSummary(checks) {
	const rows = checks ?? []
	if (rows.length === 0) return 'checks: 0'
	const count = { pass: 0, fail: 0, pending: 0, skipped: 0, unknown: 0 }
	for (const row of rows) {
		const mark = checkMark(row?.status, row?.conclusion)
		if (mark === MARK.pass) count.pass += 1
		else if (mark === MARK.fail) count.fail += 1
		else if (mark === MARK.pending) count.pending += 1
		else if (mark === MARK.skipped) count.skipped += 1
		else count.unknown += 1
	}
	return 'checks: ' + [
		count.pass + ' pass',
		count.fail + ' fail',
		count.pending + ' waiting',
		count.skipped + ' skipped',
		count.unknown > 0 ? count.unknown + ' unknown' : null,
	].filter(Boolean).join(', ') + ' (of ' + rows.length + ')'
}

/**
 * Grammar that reads well in a summary line.
 *
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function plural(count, singular, plural) {
	const word = count === 1 ? singular : (plural ?? singular + 's')
	return count + ' ' + word
}

/**
 * A head/behind pair from git rev-list --left-right --count.
 *
 * @param {string | undefined} text e.g. "2\t1"
 * @returns {{ behind: number, ahead: number } | null}
 */
export function parseAheadBehind(text) {
	const match = /^(\d+)\s+(\d+)$/.exec(String(text ?? '').trim())
	if (!match) return null
	return { behind: Number(match[1]), ahead: Number(match[2]) }
}

/**
 * Render a diff stat line ("3 files changed, 12 insertions(+), 1 deletion(-)")
 * without changing it; kept here so both git and github report identically.
 *
 * @param {string | undefined} stat
 * @param {number} [maxChars]
 * @returns {string}
 */
export function diffStat(stat, maxChars = 4000) {
	const text = String(stat ?? '').trim()
	if (text === '') return '(no changes)'
	return clip(text, maxChars)
}

/**
 * A next-step hint line. Tools end with one so a model does not have to guess
 * what the safe follow-up call is.
 *
 * @param {string[]} hints
 * @returns {string}
 */
export function nextStep(hints) {
	const list = (hints ?? []).filter(Boolean)
	if (list.length === 0) return ''
	return 'next: ' + list.join(' | ')
}

/**
 * Join non-empty blocks into one tool result.
 *
 * @param {(string | undefined)[]} parts
 * @returns {string}
 */
export function report(...parts) {
	return parts.flat().filter(part => typeof part === 'string' && part.trim() !== '').join('\n')
}
