import assert from 'node:assert/strict'
import test from 'node:test'

import { BINARY_CANDIDATES, MISSING_BINARY_COOLDOWN_MS, SAFE_ENV, clip, createRunner, firstLine, looksTransient, parseJson, redactSecrets, resolveBinary } from '../lib/cli.js'

const GH_INSTALL = 'C:/Program Files/GitHub CLI/gh.exe'
const GIT_INSTALL = 'C:/Program Files/Git/cmd/git.exe'

/** 假 spawner：記錄每次被叫的路徑，回固定的結果。真實程序從不被啟動。 */
function fakeSpawn(handler) {
	const calls = []
	return Object.assign((file, args, options) => {
		calls.push({ file, args, options })
		return Promise.resolve(handler({ file, args, options, index: calls.length - 1 }))
	}, { calls })
}

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
const fail = (stderr = 'boom') => ({ ok: false, code: 1, stdout: '', stderr, error: String(stderr).split('\n')[0] })

test('config 给的绝对路径赢过 PATH', () => {
	const found = resolveBinary('gh', { env: { PATH: 'C:/other' }, exists: () => true, override: 'D:/tools/gh.exe', platform: 'win32' })
	assert.equal(found.path, 'D:/tools/gh.exe')
	assert.equal(found.source, 'override')
}) 

test('PATH 命中就不看安装位置', () => {
	const found = resolveBinary('git', { env: { PATH: 'D:/bin' }, exists: file => /git\.exe$/i.test(file.replace(/\\/g, '/')), platform: 'win32' })
	assert.equal(found.source, 'path')
	assert.equal(found.path.replace(/\\/g, '/'), 'D:/bin/git.exe')
}) 

test('PATH 用哪種分隔符看目標平台，不看跑測試的主機', () => {
	// 這條在 Linux CI 上抓到的：主機是 posix 時用 ':' 切 'C:/nope;D:/bin'，
	// 'D:/bin' 會被切成 'D' 與 '/bin'。platform=win32 就必須用 ';'。
	const found = resolveBinary('git', { env: { PATH: 'C:/nope;D:/bin' }, exists: file => file.replace(/\\/g, '/') === 'D:/bin/git.exe', platform: 'win32' })
	assert.equal(found.source, 'path')
	assert.equal(found.path.replace(/\\/g, '/'), 'D:/bin/git.exe')
})

test('PATH 找不到时退回已知安装位置', () => {
	const found = resolveBinary('gh', { env: { PATH: 'C:/nothing' }, exists: file => file === GH_INSTALL, home: () => 'C:/Users/jimmy', platform: 'win32' })
	assert.equal(found.source, 'candidate')
	assert.equal(found.path, GH_INSTALL)
}) 

test('全部落空时回裸名，但 tried 里留着找过的位置', () => {
	const found = resolveBinary('git', { env: { PATH: 'C:/nothing' }, exists: () => false, home: () => 'C:/Users/jimmy', platform: 'win32' })
	assert.equal(found.source, 'bare')
	assert.equal(found.path, 'git')
	assert.ok(found.tried.includes(GIT_INSTALL))
	assert.equal(found.tried[found.tried.length - 1], 'git')
}) 

test('候选清单不会写进 PATH 之外的怪位置', () => {
	assert.ok(BINARY_CANDIDATES.git.every(entry => /^([A-Za-z]:\/|[~/])/.test(entry) || entry.startsWith('/')))
}) 

test('git 的环境切断所有会等人的地方', () => {
	assert.equal(SAFE_ENV.GIT_TERMINAL_PROMPT, '0')
	assert.equal(SAFE_ENV.GIT_EDITOR, 'true')
	assert.equal(SAFE_ENV.GIT_PAGER, 'cat')
	assert.equal(SAFE_ENV.GH_PAGER, 'cat')
}) 

test('token 不论出现在哪里都会被遮掉', () => {
	const secret = 'ghp_' + 'A'.repeat(36)
	const clean = redactSecrets('account: x token: ' + secret + ' github_pat_11ABCDEFGHIJ' + 'z'.repeat(20))
	assert.ok(!clean.includes(secret))
	assert.ok(!clean.includes('github_pat_11'))
	assert.match(clean, /\[redacted/)
}) 

test('firstLine 只取第一行并顺便遮罩', () => {
	assert.equal(firstLine('  第二行\n第一行\n'), '第二行')
	assert.equal(firstLine(''), '')
	assert.ok(!firstLine('bad ghp_' + 'B'.repeat(36)).includes('ghp_'))
}) 

test('run 成功时带回跑过的 argv 字串', async () => {
	const spawn = fakeSpawn(() => ok('main'))
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: file => file === '/usr/bin/git', platform: 'linux' })
	const result = await runner.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
	assert.equal(result.ok, true)
	assert.equal(result.stdout, 'main')
	assert.equal(result.command, 'git rev-parse --abbrev-ref HEAD')
}) 

test('带空格的参数会被引号包起来，不会被当成两个参数', async () => {
	const spawn = fakeSpawn(() => ok())
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux' })
	const result = await runner.run('git', ['commit', '-m', 'fix: two words'])
	assert.equal(result.command, 'git commit -m "fix: two words"')
	assert.deepEqual(spawn.calls[0].args, ['commit', '-m', 'fix: two words'])
}) 

test('每个 spawn 都带 SAFE_ENV，且不会继承要人输入的设定', async () => {
	const spawn = fakeSpawn(() => ok())
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin', HOME: '/home/u' }, exists: () => true, platform: 'linux' })
	await runner.run('git', ['status'])
	assert.equal(spawn.calls[0].options.env.GIT_TERMINAL_PROMPT, '0')
	assert.equal(spawn.calls[0].options.env.HOME, '/home/u')
}) 

test('spawn 传 env: undefined 的键会被移除，不会传字串 undefined', async () => {
	const spawn = fakeSpawn(() => ok())
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux' })
	await runner.run('git', ['status'], { env: { GIT_PAGER: undefined } })
	assert.equal('GIT_PAGER' in spawn.calls[0].options.env, false)
}) 

test('启动失败的下一个位置是另一个路径，不是重试同一位置', async () => {
	const spawn = fakeSpawn(() => ({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: true, error: '找不到执行档' }))
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: 'C:/nothing' }, exists: file => file === GH_INSTALL, home: () => 'C:/Users/jimmy', platform: 'win32' })
	const result = await runner.run('gh', ['pr', 'view'])
	assert.equal(result.ok, false)
	const files = spawn.calls.map(call => call.file)
	assert.ok(files.includes(GH_INSTALL), files.join(' | '))
	assert.equal(files[files.length - 1], 'gh')
	assert.ok(files.filter(file => file === GH_INSTALL).length === 1, '同一位置不该被叫两次：' + files.join(' | '))
	assert.match(result.error, /找不到 gh/)
	assert.match(result.error, /ghPath/)
}) 

test('找不到之后有一段时间冷却，不再重复产出同样的失败', async () => {
	let clock = 1000
	const spawn = fakeSpawn(() => ({ ok: false, code: null, stdout: '', stderr: '', spawnFailed: true, error: '找不到执行档' }))
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: 'C:/nothing' }, exists: () => false, home: () => 'C:/x', platform: 'win32', now: () => clock })
	await runner.run('gh', ['pr', 'view'])
	const first = spawn.calls.length
	clock += 1000
	const second = await runner.run('gh', ['pr', 'view'])
	assert.equal(spawn.calls.length, first, '冷却期内不该再 spawn')
	assert.match(second.error, /幾秒前/)
	clock += MISSING_BINARY_COOLDOWN_MS
	await runner.run('gh', ['pr', 'view'])
	assert.ok(spawn.calls.length > first, '过了冷却就该重新试一次')
}) 

test('逾时是失败，而且要讲能重试或提高上限', async () => {
	const spawn = fakeSpawn(() => ({ ok: false, code: null, stdout: '', stderr: '', timedOut: true, error: '逾時 60000ms，已中止' }))
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux' })
	const result = await runner.run('git', ['fetch'])
	assert.equal(result.timedOut, true)
	assert.match(result.error, /超過 60000ms/)
	assert.match(result.error, /timeoutMs/)
}) 

test('非暂态错误只跑一次，暂态错误重试一次', async () => {
	const fatal = fakeSpawn(() => fail('fatal: not a git repository'))
	const fatalRunner = createRunner({ spawnProcess: fatal, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux', delay: async () => {} })
	const fatalResult = await fatalRunner.run('git', ['status'])
	assert.equal(fatal.calls.length, 1)
	assert.match(fatalResult.error, /not a git repository/)

	let seen = 0
	const transient = fakeSpawn(() => (++seen === 1 ? fail('fatal: unable to access: Could not resolve host: github.com') : ok('done')))
	const transientRunner = createRunner({ spawnProcess: transient, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux', delay: async () => {} })
	const result = await transientRunner.run('git', ['fetch'])
	assert.equal(result.ok, true)
	assert.equal(result.retried, true)
	assert.equal(transient.calls.length, 2)
}) 

test('index.lock 撞到算暂态，会重试一次', async () => {
	let seen = 0
	const spawn = fakeSpawn(() => (++seen === 1 ? fail('fatal: Unable to create index.lock: File exists.') : ok()))
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: () => true, platform: 'linux', delay: async () => {} })
	const result = await runner.run('git', ['add', '.'])
	assert.equal(result.ok, true)
}) 

test('404 不该被重试', () => {
	assert.equal(looksTransient('HTTP 404: Not Found'), false)
	assert.equal(looksTransient('secondary rate limit'), true)
	assert.equal(looksTransient('Unable to create index.lock: File exists'), true)
	assert.equal(looksTransient('fatal: not a git repository'), false)
}) 

test('locate 会记住找到的位置', async () => {
	const spawn = fakeSpawn(() => ok())
	const runner = createRunner({ spawnProcess: spawn, env: { PATH: '/usr/bin' }, exists: file => /gh(\.exe)?$/i.test(file), platform: 'linux' })
	await runner.run('gh', ['--version'])
	assert.equal(runner.locate('gh').source, 'cached')
	runner.reset()
	assert.equal(runner.locate('gh').source, 'path')
}) 

test('parseJson 的失败要说它看到什么', () => {
	assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } })
	assert.equal(parseJson('').ok, false)
	assert.match(parseJson('not json').error, /JSON 解析失敗/)
}) 

test('clip 截的是头端并说明掉多少', () => {
	const long = 'x'.repeat(5000)
	const cut = clip(long, 1000)
	assert.ok(cut.length < 1100)
	assert.match(cut, /剩 4060 字元/)
	assert.equal(clip('短', 1000), '短')
}) 
