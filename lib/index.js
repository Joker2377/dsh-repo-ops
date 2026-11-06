/**
 * dsh-repo-ops — the DSH entry point.
 *
 * The bundle registers nine tools that wrap the git and GitHub CLI into
 * structured calls: repo_status, repo_diff, repo_commit, repo_push, repo_branch,
 * repo_pr, repo_ci, repo_issue, repo_release. Without them the same facts cost
 * an agent ten shell calls plus free-text parsing each time; the point of this
 * bundle is that one call answers the question.
 *
 * This file only wires: config -> runner -> git/github -> tools, all inside one
 * effect so disabling the bundle unregisters every tool instead of leaving
 * stale entries after a reload.
 *
 * @module dsh-repo-ops/index
 */

import { createRunner } from './cli.js'
import { createGit } from './git.js'
import { createGithub } from './github.js'
import { createTools } from './tools.js'

export const name = 'dsh-repo-ops'

/** Only the tool registry is needed; git and gh are found on PATH, not through a host service. */
export const inject = ['tools']

/**
 * Settings a profile may pass through cordis.patch.yml's config block. Plain
 * values only — apply() reads them as-is.
 */
export const Config = {
	ghPath: { type: 'string', default: '' },
	gitPath: { type: 'string', default: '' },
	timeoutMs: { type: 'number', default: 60000 },
	watchTimeoutMs: { type: 'number', default: 300000 },
	readOnly: { type: 'boolean', default: false },
}

/** The settings the rest of the bundle works with, after defaults. */
export const DEFAULT_SETTINGS = {
	ghPath: '',
	gitPath: '',
	timeoutMs: 60000,
	watchTimeoutMs: 300000,
	readOnly: false,
	host: 'github.com',
}

/**
 * Merge a profile's config into usable settings. Exported so tests can check
 * the merge without a host.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {{ ghPath: string, gitPath: string, timeoutMs: number, watchTimeoutMs: number, readOnly: boolean, host: string }}
 */
export function toSettings(config = {}) {
	const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
	const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
	const timeoutMs = number(config.timeoutMs, DEFAULT_SETTINGS.timeoutMs)
	return {
		ghPath: text(config.ghPath, DEFAULT_SETTINGS.ghPath),
		gitPath: text(config.gitPath, DEFAULT_SETTINGS.gitPath),
		timeoutMs,
		watchTimeoutMs: Math.max(number(config.watchTimeoutMs, DEFAULT_SETTINGS.watchTimeoutMs), timeoutMs),
		readOnly: config.readOnly === true,
		host: DEFAULT_SETTINGS.host,
	}
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof Config>} [config]
 */
export function apply(ctx, config = {}) {
	const settings = toSettings(config)
	return once(ctx.effect(() => {
		const overrides = {}
		if (settings.ghPath !== '') overrides.gh = settings.ghPath
		if (settings.gitPath !== '') overrides.git = settings.gitPath
		const runner = createRunner({ env: process.env, overrides, timeoutMs: settings.timeoutMs })
		const git = createGit({ run: runner.run, env: process.env })
		const github = createGithub({ run: runner.run, git, settings })
		/** @type {(() => void)[]} */
		const disposers = []
		for (const tool of createTools({ git, github, settings })) {
			const dispose = ctx.tools.register(tool)
			disposers.push(typeof dispose === 'function' ? dispose : () => {})
		}
		ctx.logger?.info?.('dsh-repo-ops: registered 9 tools (git via ' + runner.locate('git').source + ', gh via ' + runner.locate('gh').source + ')')
		return () => {
			for (const dispose of disposers.reverse()) {
				try {
					dispose()
				} catch (error) {
					ctx.logger?.warn?.('dsh-repo-ops: unregistering a tool failed — ' + String(error?.message ?? error))
				}
			}
		}
	}), 'dsh-repo-ops: tools')
}

/**
 * Wrap a disposer so a second call is a no-op. A reload can hand the same
 * effect's cleanup to the host twice, and unregistering a tool that is already
 * gone is how bundles get a stack trace in the log for no reason.
 */
function once(dispose) {
	let done = false
	return () => {
		if (done) return
		done = true
		dispose()
	}
}
