import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config, DEFAULT_SETTINGS, inject, name, toSettings } from '../lib/index.js'

/** 只實作 apply() 會碰到的部分：註冊表與 effect。disposer 要真的會被叫到。 */
function fakeContext() {
	const registered = []
	const cleaned = []
	const ctx = {
		tools: {
			register(definition) {
				registered.push(definition)
				return () => cleaned.push(definition.name)
			},
		},
		logger: { info() {}, warn() {}, error() {} },
		effect(body) {
			const dispose = body()
			return () => dispose()
		},
	}
	return { ctx, registered, cleaned }
}

test('bundle 宣告 DSH 需要的 identity 與 service', () => {
	assert.equal(name, 'dsh-repo-ops')
	assert.deepEqual(inject, ['tools'])
	assert.ok(Config && typeof Config === 'object')
})

test('Config 是 cordis 真的會呼叫的 standard-schema', () => {
	// cordis 的 resolveConfig 就是這四行（lib/fiber.js）：沒有 ~standard 就
	// dereference undefined，整個外掛在 profile 載入時就掛掉 —— 0.1.1 的實際死因。
	const resolve = raw => {
		assert.ok(Config['~standard'], 'Config 必須有 ~standard')
		const result = Config['~standard'].validate(raw)
		assert.equal('then' in result, false, '不能是非同步驗證')
		if (result.issues) throw new TypeError('invalid config')
		return result.value
	}
	const defaults = resolve(undefined)
	assert.equal(defaults.timeoutMs, DEFAULT_SETTINGS.timeoutMs)
	assert.equal(defaults.readOnly, false)
	const tuned = resolve({ timeoutMs: 90000, readOnly: true })
	assert.equal(tuned.timeoutMs, 90000)
	assert.equal(tuned.readOnly, true)
	assert.throws(() => resolve({ timeoutMs: 'soon' }), /invalid config/)
	assert.throws(() => resolve({ timeoutMS: 90000 }), /invalid config/, '打錯的鍵要變成可讀 issues，而不是被默默忽略')
	assert.throws(() => resolve('nope'), /invalid config/)
	const issues = Config['~standard'].validate({ timeoutMs: 'soon', nope: 1 }).issues
	assert.equal(issues.length, 2)
	assert.match(issues[0].message, /timeoutMs 必須是 number/)
	assert.match(issues[1].message, /不認識的 config 鍵 nope/)
})

test('apply() 在 ctx.effect 內註冊九個工具，名字與 README 一致', () => {
	const { ctx, registered } = fakeContext()
	const dispose = apply(ctx, {})
	assert.equal(typeof dispose, 'function')
	const names = registered.map(tool => tool.name)
	assert.deepEqual(names, ['repo_status', 'repo_diff', 'repo_commit', 'repo_push', 'repo_branch', 'repo_pr', 'repo_ci', 'repo_issue', 'repo_release'])
}) 

test('卸載時每個工具都被 unregister，且不會叫兩次', () => {
	const { ctx, registered, cleaned } = fakeContext()
	const dispose = apply(ctx, {})
	dispose()
	assert.deepEqual(cleaned.sort(), registered.map(tool => tool.name).sort())
	dispose()
	assert.equal(cleaned.length, registered.length)
}) 

test('每個工具都有參數表、字串輸出與讀寫宣告', () => {
	const { ctx, registered } = fakeContext()
	apply(ctx, {})
	for (const tool of registered) {
		assert.equal(typeof tool.description, 'string')
		assert.ok(tool.description.length > 60, tool.name + ' 的說明太短')
		assert.equal(typeof tool.parameters, 'object')
		assert.deepEqual(tool.output.schema, { type: 'string' })
		assert.equal(typeof tool.isConcurrencySafe, 'function')
		assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)
		for (const [key, parameter] of Object.entries(tool.parameters)) {
			assert.equal(typeof parameter.description, 'string', tool.name + '.' + key + ' 缺 description')
			assert.ok(['string', 'number', 'boolean', 'array', 'object'].includes(parameter.type), tool.name + '.' + key + ' 型別不對')
			assert.equal(parameter.default, undefined, tool.name + '.' + key + ' 用了 host 不吃的 default')
		}
	}
}) 

test('寫入型工具宣告不可併行，讀取型可以', () => {
	const { ctx, registered } = fakeContext()
	apply(ctx, {})
	const byName = new Map(registered.map(tool => [tool.name, tool]))
	assert.equal(byName.get('repo_status').isConcurrencySafe({}), true)
	assert.equal(byName.get('repo_diff').isConcurrencySafe({}), true)
	assert.equal(byName.get('repo_commit').isConcurrencySafe({}), false)
	assert.equal(byName.get('repo_push').isConcurrencySafe({}), false)
}) 

test('config 的預設值與邊界', () => {
	assert.deepEqual(toSettings(undefined), { ...DEFAULT_SETTINGS })
	const merged = toSettings({ timeoutMs: 90000, ghPath: ' C:/gh/gh.exe ', readOnly: true })
	assert.equal(merged.timeoutMs, 90000)
	assert.equal(merged.ghPath, 'C:/gh/gh.exe')
	assert.equal(merged.readOnly, true)
	// watch 不能比單條指令還短
	assert.equal(toSettings({ timeoutMs: 200000, watchTimeoutMs: 1000 }).watchTimeoutMs, 200000)
	// 壞值退回預設
	assert.equal(toSettings({ timeoutMs: 'soon' }).timeoutMs, DEFAULT_SETTINGS.timeoutMs)
}) 