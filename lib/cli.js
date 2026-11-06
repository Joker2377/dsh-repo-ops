/**
 * Process running for the git and gh CLIs.
 *
 * Three rules shape this file. First: argv arrays only, never a shell, so a
 * branch name containing a space or a quote can never become a command. Second:
 * a failure is a value, never an exception - every caller gets ok:false plus an
 * error string that names a next step, instead of a stack trace. Third: binary
 * discovery. The App process does not always inherit the PATH a login shell has
 * (GitHub CLI installed after the App launched stays invisible to it until a
 * restart), so a name that will not start is retried from a PATH scan and a
 * short list of install locations before anything is reported as missing.
 *
 * Nothing spawns at import time: npm test and CI import this module with an
 * injected spawner and never start a process.
 *
 * @module dsh-repo-ops/cli
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 60000
export const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024
/** A name that could not be started at all is not retried for this long. */
export const MISSING_BINARY_COOLDOWN_MS = 30000

/** Install locations tried when a bare name is not found on PATH. */
export const BINARY_CANDIDATES = {
	git: ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe', '/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'],
	gh: ['C:/Program Files/GitHub CLI/gh.exe', '/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'],
}

/** Environment for every child process: nothing may block waiting for a human. */
export const SAFE_ENV = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_EDITOR: 'true',
	GIT_SEQUENCE_EDITOR: 'true',
	GIT_MERGE_AUTOEDIT: 'no',
	GIT_PAGER: 'cat',
	GH_PAGER: 'cat',
	GH_PROMPT_DISABLED: '1',
}

const WINDOWS_SUFFIXES = ['.exe', '.cmd', '.bat', '']
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{4,}|github_pat_[A-Za-z0-9_]{4,}|ghu_[A-Za-z0-9]{4,})\b/g
const SECRET_ASSIGNMENT = /((?:token|password|secret|authorization)[ "' ]*[:=][ "' ]*)[^\s"',}]+/gi
const TRANSIENT = /secondary rate limit|abuse detection|retry later|ECONNRESET|socket hang up|could not resolve host|connection reset|temporarily unavailable|\b50[234]\b|index\.lock|cannot lock ref|unable to lock/i

/**
 * Find a binary without starting one: explicit override, then PATH plus the
 * usual user bins, then known install locations, then the bare name as a last
 * try because the OS may still know something we do not.
 *
 * @param {string} name bare command name, for example "git"
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(p: string) => boolean} [options.exists]
 * @param {() => string} [options.home]
 * @param {Record<string, string[]>} [options.candidates]
 * @param {string} [options.override] explicit path; wins over everything
 * @param {string} [options.platform]
 * @returns {{ path: string, source: string, tried: string[] }}
 */
export function resolveBinary(name, options = {}) {
	const { env = process.env, exists = existsSync, home = homedir, candidates = BINARY_CANDIDATES, override, platform = process.platform } = options
	const tried = []
	if (typeof override === 'string' && override.trim() !== '') return { path: override.trim(), source: 'override', tried }
	const suffixes = name.includes('.') ? [''] : (platform === 'win32' ? WINDOWS_SUFFIXES : [''])
	// The path flavour follows the *target* platform, not the host running this
	// code: splitting a Windows PATH with ':' turns 'D:/bin' into 'D' and
	// '/bin', which is exactly the cross-platform bug the Linux CI job caught.
	const paths = platform === 'win32' ? win32 : posix
	const dirs = String(env.PATH ?? env.Path ?? env.path ?? '').split(paths.delimiter).filter(Boolean)
	const extras = []
	try {
		extras.push(paths.join(home(), '.local', 'bin'), paths.join(home(), 'bin'))
	} catch {
		/* no home directory, so no user bin to look in */
	}
	for (const dir of [...dirs, ...extras]) {
		for (const suffix of suffixes) {
			const file = paths.join(dir, name + suffix)
			tried.push(file)
			if (exists(file)) return { path: file, source: 'path', tried }
		}
	}
	for (const candidate of candidates[name] ?? []) {
		tried.push(candidate)
		if (exists(candidate)) return { path: candidate, source: 'candidate', tried }
	}
	tried.push(name)
	return { path: name, source: 'bare', tried }
}

/**
 * Strip anything shaped like a credential from text headed for the model.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
	return String(text ?? '')
		.replace(TOKEN_PATTERN, '[redacted-token]')
		.replace(SECRET_ASSIGNMENT, '$1[redacted]')
}

/**
 * The real spawner, shaped so callers never have to catch anything: every
 * outcome - started, refused, timed out - comes back as a result object.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawn]
 * @returns {(file: string, args: string[], opts?: object) => Promise<object>}
 */
export function createSpawner(options = {}) {
	const spawn = options.spawn ?? nodeSpawn
	const files = options.files ?? fileHelpers()
	return (file, args, opts = {}) => new Promise(resolve => {
		let fellBack = false
		const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
		let child
		try {
			child = spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
		} catch (error) {
			// A sandbox that forbids pipe creation throws here rather than emitting
			// an error event; nothing started, so retry once through temp files.
			if (error?.code === 'EPERM' && opts.useFiles !== false) {
				fellBack = true
				spawnThroughFiles(file, args, opts, spawn, files).then(resolve)
				return
			}
			resolve({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: error?.code === 'ENOENT', error: describeSpawnError(error) })
			return
		}
		const out = []
		const err = []
		let bytes = 0
		let settled = false
		let timedOut = false
		const collect = bucket => chunk => {
			if (bytes > maxBuffer) return
			const text = String(chunk)
			bytes += Buffer.byteLength(text)
			bucket.push(text)
		}
		child.stdout?.on('data', collect(out))
		child.stderr?.on('data', collect(err))
		child.stdin?.on('error', () => { /* EPIPE when the command exits before reading stdin */ })
		if (opts.stdin !== undefined) child.stdin?.end(String(opts.stdin))
		const timer = setTimeout(() => {
			timedOut = true
			try {
				child.kill('SIGKILL')
			} catch {
				/* already gone */
			}
		}, timeoutMs)
		const finish = result => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(result)
		}
		child.on('error', error => {
			// A confined sandbox may forbid creating pipes; nothing ran in that case,
			// so the same argv is retried once through temp files instead. No command
			// is ever run twice for real.
			if (!fellBack && error?.code === 'EPERM' && opts.useFiles !== false) {
				fellBack = true
				clearTimeout(timer)
				spawnThroughFiles(file, args, opts, spawn, files).then(finish)
				return
			}
			finish({
				ok: false,
				code: null,
				stdout: joinChunks(out),
				stderr: joinChunks(err),
				spawnFailed: error?.code === 'ENOENT',
				error: describeSpawnError(error),
			})
		})
		child.on('close', (code, signal) => {
			const stdout = joinChunks(out)
			const stderr = joinChunks(err)
			if (timedOut) {
				finish({ ok: false, code: null, stdout, stderr, timedOut: true, error: '逾時 ' + timeoutMs + 'ms，已中止' })
				return
			}
			if (code === 0) {
				finish({ ok: true, code: 0, stdout, stderr })
				return
			}
			finish({
				ok: false,
				code: code ?? null,
				stdout,
				stderr,
				error: firstLine(stderr) || firstLine(stdout) || (signal ? '被 ' + signal + ' 中止' : '退出碼 ' + (code ?? 'null')),
			})
		})
	})
}

/**
 * The same command with its output going to temp files rather than pipes.
 *
 * Only reached when the pipe route could not start at all, which means nothing
 * ran, so retrying cannot double-apply a mutation. Sandboxes that block
 * pipe creation (a confined agent shell, for one) otherwise make every git and
 * gh call fail with a bare EPERM the user cannot act on.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} opts
 * @param {Function} spawn
 * @param {{ tmp: () => string, open: (p: string) => number, read: (p: string) => string, close: (fd: number) => void, unlink: (p: string) => void }} io
 * @returns {Promise<object>}
 */
function spawnThroughFiles(file, args, opts, spawn, io) {
	const dir = io.tmp()
	const outPath = join(dir, 'dsh-repo-ops-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.out')
	const errPath = outPath + '.err'
	const inPath = opts.stdin === undefined ? null : outPath + '.in'
	let out
	let err
	let input
	return new Promise(resolve => {
		try {
			out = io.open(outPath)
			err = io.open(errPath)
			if (inPath !== null) {
				io.writeFile(inPath, String(opts.stdin))
				input = io.open(inPath, 'r')
			}
		} catch (error) {
			resolve({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: false, error: '無法建立暫存輸出檔：' + describeSpawnError(error) })
			return
		}
		const stdio = [inPath === null ? 'ignore' : input, out, err]
		let child
		try {
			child = spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio })
		} catch (error) {
			cleanup(out, err, input, outPath, errPath, inPath, io)
			resolve({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: error?.code === 'ENOENT', error: describeSpawnError(error) })
			return
		}
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL')
			} catch {
				/* already gone */
			}
		}, Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS))
		let settled = false
		const finish = result => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			cleanup(out, err, input, outPath, errPath, inPath, io)
			resolve(result)
		}
		child.on('error', error => finish({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: error?.code === 'ENOENT', error: describeSpawnError(error) }))
		child.on('close', code => {
			const stdout = safeRead(io, outPath)
			const stderr = safeRead(io, errPath)
			if (code === 0) finish({ ok: true, code: 0, stdout, stderr })
			else finish({ ok: false, code: code ?? null, stdout, stderr, error: firstLine(stderr) || firstLine(stdout) || '退出碼 ' + (code ?? 'null') + '（檔案擷取模式）' })
		})
	})
}

function fileHelpers() {
	return {
		tmp: () => tmpdir(),
		open: (path, flag = 'w') => openSync(path, flag),
		writeFile: (path, body) => writeFileSync(path, body),
		close: fd => closeSync(fd),
		unlink: path => unlinkSync(path),
		read: path => readFileSync(path, 'utf8'),
	}
}

function cleanup(out, err, input, outPath, errPath, inPath, io) {
	for (const fd of [out, err, input]) {
		if (typeof fd === 'number') try { io.close(fd) } catch { /* already closed */ }
	}
	for (const path of [outPath, errPath, inPath]) {
		if (typeof path === 'string') try { io.unlink(path) } catch { /* already gone */ }
	}
}

function safeRead(io, path) {
	try {
		return io.read(path)
	} catch {
		return ''
	}
}

function joinChunks(chunks) {
	return chunks.length === 0 ? '' : chunks.join('')
}

function describeSpawnError(error) {
	if (error?.code === 'ENOENT') return '找不到執行檔'
	if (error?.code === 'EACCES') return '沒有執行權限'
	return String(error?.message ?? error ?? '無法啟動')
}

/**
 * Runs a command and resolves where the binary lives.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createSpawner>} [options.spawnProcess]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(p: string) => boolean} [options.exists]
 * @param {() => string} [options.home]
 * @param {Record<string, string[]>} [options.candidates]
 * @param {Record<string, string>} [options.overrides] per-binary paths from plugin config
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBuffer]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.delay]
 * @param {string} [options.platform]
 * @returns {{ run: Function, locate: Function, reset: () => void }}
 */
export function createRunner(options = {}) {
	const {
		spawnProcess = createSpawner(),
		env = process.env,
		exists = existsSync,
		home = homedir,
		candidates = BINARY_CANDIDATES,
		overrides = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxBuffer = DEFAULT_MAX_BUFFER,
		now = () => Date.now(),
		delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
		platform = process.platform,
	} = options
	const located = new Map()
	const missing = new Map()

	function locate(name) {
		const cached = located.get(name)
		if (cached !== undefined) return { path: cached, source: 'cached' }
		const found = resolveBinary(name, { env, exists, home, candidates, override: overrides[name], platform })
		if (found.source !== 'bare') located.set(name, found.path)
		return found
	}

	function childEnv(extra) {
		const base = { ...env, ...SAFE_ENV }
		for (const [key, value] of Object.entries(extra ?? {})) {
			if (value === undefined) delete base[key]
			else base[key] = String(value)
		}
		return base
	}

	function commandLine(name, args) {
		return [name, ...args].map(part => (/[\s"]/).test(part) || part === '' ? JSON.stringify(part) : part).join(' ')
	}

	/** Locations to try, in order: the resolved one, existing candidates, then the bare name. */
	function order(name) {
		const list = [locate(name).path]
		for (const candidate of candidates[name] ?? []) if (!list.includes(candidate) && exists(candidate)) list.push(candidate)
		if (!list.includes(name)) list.push(name)
		return [...new Set(list)]
	}

	async function run(name, args, callOptions = {}) {
		const perCall = callOptions.timeoutMs ?? timeoutMs
		const retries = Math.max(0, callOptions.retries ?? 1)
		const cold = missing.get(name) ?? 0
		if (cold > now()) {
			return { ok: false, code: null, stdout: '', stderr: '', command: name, error: name + ' 在幾秒前才確認過找不到或無法啟動；這輪先別重試，請確認安裝或在 config 指定路徑' }
		}
		const command = commandLine(name, args)
		const tried = []
		for (const file of order(name)) {
			tried.push(file)
			for (let attempt = 0; attempt <= retries; attempt += 1) {
				const result = await spawnProcess(file, args, { cwd: callOptions.cwd, env: childEnv(callOptions.env), timeoutMs: perCall, stdin: callOptions.stdin, maxBuffer })
				if (result.ok) return { ...result, command, file, retried: attempt > 0 ? true : undefined }
				// A name that will not start at all: the fix is the next location, not a retry.
				if (result.spawnFailed === true) break
				if (result.timedOut === true) {
					return { ...result, command, file, timedOut: true, error: command + ' 超過 ' + perCall + 'ms 未完成（已中止）。網路型指令可稍後重試，或提高 timeoutMs' }
				}
				const text = String(result.stderr ?? '') + String(result.stdout ?? '') + String(result.error ?? '')
				if (attempt < retries && looksTransient(text)) {
					await delay(400 * (attempt + 1))
					continue
				}
				return { ...result, command, file, retried: attempt > 0 ? true : undefined }
			}
		}
		missing.set(name, now() + MISSING_BINARY_COOLDOWN_MS)
		return {
			ok: false,
			code: null,
			stdout: '',
			stderr: '',
			command,
			error: '找不到 ' + name + '。試過：' + tried.slice(0, 6).join('、') + '。若是 GitHub CLI，請安裝 GitHub CLI，或在 dsh-repo-ops 的 config 指定 ghPath',
		}
	}

	return {
		run,
		locate,
		reset() {
			located.clear()
			missing.clear()
		},
	}
}

/**
 * Failures worth one retry: secondary rate limits and dropped connections.
 * A 404 is not transient, and retrying one burns a turn.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksTransient(text) {
	return TRANSIENT.test(String(text ?? ''))
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function firstLine(text) {
	const line = String(text ?? '').split(/\r?\n/).find(l => l.trim() !== '') ?? ''
	return redactSecrets(line).trim()
}

/**
 * Parse stdout as JSON, reporting a readable failure instead of throwing.
 *
 * @param {string} text
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function parseJson(text) {
	const trimmed = String(text ?? '').trim()
	if (trimmed === '') return { ok: false, error: '輸出是空的，無法解析為 JSON' }
	try {
		return { ok: true, value: JSON.parse(trimmed) }
	} catch (error) {
		return { ok: false, error: 'JSON 解析失敗：' + firstLine(error?.message ?? error) + '；前 60 字：' + trimmed.slice(0, 60) }
	}
}

/**
 * Truncate long output for the model while keeping the shape of what fell off.
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function clip(text, maxChars = 6000) {
	const value = String(text ?? '')
	if (value.length <= maxChars) return value
	const cut = Math.max(0, maxChars - 60)
	return value.slice(0, cut) + '\n…（已截斷，剩 ' + (value.length - cut) + ' 字元；需要更多請縮小 range 或提高 maxChars）'
}
