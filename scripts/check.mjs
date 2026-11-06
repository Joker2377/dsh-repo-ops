#!/usr/bin/env node
// Shape check for this DSH bundle repo: manifest targets, patch insert, entry
// contract, tool surface, README sections, and offline tests. Runs before
// npm test in CI - it is the only defence against "installs broken but every
// unit test was green".
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const errors = []
const warnings = []
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)

const pkg = JSON.parse(read('package.json'))

// --- manifest ---------------------------------------------------------------
if (!/^dsh-[a-z0-9-]+$/.test(pkg.name ?? '')) fail('package.json name "' + pkg.name + '" should be dsh-<purpose>')
if (pkg.type !== 'module') fail('package.json type must be "module"')
if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? '')) fail('package.json version must be semver; a release tag is derived from it')
if (!(pkg.files ?? []).length) fail('package.json files is empty; the tarball would be nearly empty')
if (!pkg.dsh?.bundle?.patch) fail('package.json dsh.bundle.patch is missing; DSH will not load this bundle')
if (!(pkg.keywords ?? []).includes('dsh-plugin')) warn('keywords should include "dsh-plugin"')
if (!existsSync(resolve(root, 'LICENSE'))) fail('LICENSE is missing')
if (!pkg.engines?.dsh) warn('engines.dsh is missing; compatibility would fall to the peer rule')
if (typeof pkg.author !== 'string' || pkg.author.includes('<')) fail('package.json author is still a placeholder')
if (!pkg.peerDependencies?.['@deepseek-ai/dsh-tools']) warn('peerDependencies @deepseek-ai/dsh-tools is missing')

// Every export target must exist, or the bundle cannot load.
const targets = new Set()
if (pkg.main) targets.add(pkg.main)
const exportsField = pkg.exports
if (typeof exportsField === 'string') targets.add(exportsField)
else if (exportsField && typeof exportsField === 'object') {
	for (const value of Object.values(exportsField)) {
		if (typeof value === 'string') targets.add(value)
		else if (value && typeof value === 'object') for (const nested of Object.values(value)) if (typeof nested === 'string') targets.add(nested)
	}
}
for (const target of targets) if (!existsSync(resolve(root, target))) fail('exports target does not exist: ' + target)

// files must cover every runtime file the manifest points at.
const norm = (path) => path.replace(/^\.\//, '').replace(/\/$/, '')
const listed = (pkg.files ?? []).map(norm)
for (const raw of targets) {
	const target = norm(raw)
	if (target === 'package.json') continue
	const covered = listed.some(entry => target === entry || target.startsWith(entry + '/') || (entry.includes('*') && target.startsWith(entry.split('*')[0])))
	if (!covered) fail('files does not cover runtime file: ' + raw)
}

// --- patch ------------------------------------------------------------------
const patchPath = norm(pkg.dsh?.bundle?.patch ?? '')
let patch = ''
if (patchPath !== '' && existsSync(resolve(root, patchPath))) {
	patch = read(patchPath)
	if (!/^\s*-\s*insert:/m.test(patch)) fail(patchPath + ' has no insert row; the bundle would install as a no-op')
	const ids = [...patch.matchAll(/\bid:\s*([^\s#]+)/g)].map(match => match[1])
	if (new Set(ids).size !== ids.length) fail(patchPath + ' repeats an insert id')
	if (!new RegExp('name:\\s*' + String(pkg.name).replace('.', '\\.') + '\\b').test(patch)) fail(patchPath + ' does not name ' + pkg.name)
}

// --- entry point ------------------------------------------------------------
const entry = read(norm(pkg.main ?? './lib/index.js'))
if (!/export const name\s*=\s*'/.test(entry)) fail('entry point must export const name')
if (!/export (async )?function apply/.test(entry)) fail('entry point must export apply(ctx, config)')
if (!/ctx\.effect\(/.test(entry)) fail('entry point registers outside ctx.effect; tools would survive a disable')
if (patch !== '' && /\bconfig:/.test(patch) && !/export const Config/.test(entry)) fail('the patch passes a config block but the entry exports no Config; the values would be dropped')

// --- tool surface -----------------------------------------------------------
const libFiles = readdirSync(resolve(root, 'lib')).filter(file => file.endsWith('.js'))
const toolsSource = existsSync(resolve(root, 'lib/tools.js')) ? read(join('lib', 'tools.js')) : ''
const toolNames = [...toolsSource.matchAll(/name:\s*'(repo_[a-z_]+)'/g)].map(match => match[1])
if (toolNames.length === 0) fail('no repo_* tool definition under lib/; the bundle would register nothing')
if (new Set(toolNames).size !== toolNames.length) fail('duplicate tool name: ' + toolNames.join(', '))
for (const file of libFiles) {
	const source = read(join('lib', file))
	if (/\bexecSync\(|\bshell:\s*true|spawnSync\(/.test(source)) fail('lib/' + file + ' runs a command through a shell; pass an argv array instead')
}
if (/\.\.—|TODO|FIXME|placeholder/.test(toolsSource)) warn('lib/tools.js still carries a TODO/FIXME marker')

// --- README -----------------------------------------------------------------
const REQUIRED_SECTIONS = ['功能', '安裝', '使用', '疑難排解', '運作原理', '開發', '已知限制']
const readme = existsSync(resolve(root, 'README.md')) ? read('README.md') : ''
if (!readme) fail('README.md is missing')
else {
	for (const section of REQUIRED_SECTIONS) if (!readme.includes('## ' + section)) fail('README.md is missing section: ## ' + section)
	if (!/https:\/\/github\.com\/[^/\s]+\/[^/\s#?]+/m.test(readme)) warn('README install section should carry the repository home URL')
	for (const name of toolNames) if (!readme.includes(name)) fail('README never mentions the tool ' + name)
}

// --- tests must stay offline ------------------------------------------------
const testDir = resolve(root, 'test')
if (!existsSync(testDir)) fail('test/ is missing; nothing verifies this bundle')
else {
	for (const file of readdirSync(testDir).filter(name => name.endsWith('.test.mjs'))) {
		const body = read(join('test', file))
		if (/\bfetch\s*\(\s*['"]https/.test(body)) fail('test/' + file + ' fetches a live endpoint; inject a fake instead')
		if (/execFile\s*\(\s*['"](gh|git)['"]|spawn\s*\(\s*['"](gh|git)['"]/.test(body)) fail('test/' + file + ' shells out to a real CLI; inject a fake runner instead')
	}
}

// --- artifacts --------------------------------------------------------------
for (const name of readdirSync(root)) if (name.endsWith('.tgz')) warn('*.tgz in the repo root: ' + name + ' belongs in a GitHub release, not in git')

// --- report -----------------------------------------------------------------
for (const message of warnings) console.warn('warn  ' + message)
for (const message of errors) console.error('error ' + message)
if (errors.length) process.exit(1)
console.log('ok    ' + pkg.name + '@' + pkg.version + ' — ' + toolNames.length + ' tools, ' + warnings.length + ' warning(s)')
