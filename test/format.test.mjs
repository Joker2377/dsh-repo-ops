import assert from 'node:assert/strict'
import test from 'node:test'

import { MARK, bullets, checkMark, checkSummary, diffStat, fields, nextStep, parseAheadBehind, plural, report, section, table } from '../lib/format.js'

test('fields 一行一鍵，空的欄位不出現', () => {
	assert.deepEqual(fields({ branch: 'main', upstream: null, clean: true, labels: ['a', 'b'], none: '' }).split('\n'), [
		'branch: main', 'clean: yes', 'labels: a, b',
	])
}) 

test('table 對齊、截斷、右對齊', () => {
	const lines = table([
		{ key: 'name', label: 'name', width: 8 },
		{ key: 'n', label: 'n', width: 4, align: 'right' },
	], [{ name: 'abc', n: 1 }, { name: 'a-toolong-name-for-the-column', n: 22 }]).split('\n')
	assert.equal(lines.length, 3)
	assert.ok(lines[1].startsWith('abc     '), JSON.stringify(lines[1]))
	assert.ok(lines[2].includes('22'), lines[2])
	assert.ok(lines[2].includes('…'), '超長欄位要標出截斷：' + JSON.stringify(lines[2]))
}) 

test('table 的 null 顯示為連字號，不是 null 字面', () => {
	assert.match(table([{ key: 'x', label: 'x' }], [{ x: null }]), /-\s*$/)
}) 

test('checkMark 覆蓋六種狀態', () => {
	assert.equal(checkMark('completed', 'success'), MARK.pass)
	assert.equal(checkMark('completed', 'failure'), MARK.fail)
	assert.equal(checkMark('completed', 'timed_out'), MARK.fail)
	assert.equal(checkMark('in_progress'), MARK.pending)
	assert.equal(checkMark('queued'), MARK.pending)
	assert.equal(checkMark('completed', 'skipped'), MARK.skipped)
	assert.equal(checkMark('completed', 'neutral'), MARK.skipped)
	assert.equal(checkMark('completed'), MARK.neutral)
	assert.equal(checkMark(undefined, undefined), MARK.unknown)
}) 

test('checkSummary 給總數與分類', () => {
	assert.equal(checkSummary([]), 'checks: 0')
	const text = checkSummary([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'queued' }])
	assert.equal(text, 'checks: 1 pass, 1 fail, 1 waiting, 0 skipped (of 3)')
}) 

test('parseAheadBehind 吃 rev-list 的兩個數字', () => {
	assert.deepEqual(parseAheadBehind('2\t1'), { behind: 2, ahead: 1 })
	assert.deepEqual(parseAheadBehind('0 3'), { behind: 0, ahead: 3 })
	assert.equal(parseAheadBehind('nope'), null)
	assert.equal(parseAheadBehind(''), null)
}) 

test('diffStat 原樣呈現，空的就是沒有變更', () => {
	assert.equal(diffStat(' 3 files changed, 12 insertions(+), 4 deletions(-)'), '3 files changed, 12 insertions(+), 4 deletions(-)')
	assert.equal(diffStat(''), '(no changes)')
}) 

test('plural 的單複數', () => {
	assert.equal(plural(1, 'change'), '1 change')
	assert.equal(plural(2, 'change'), '2 changes')
	assert.equal(plural(3, 'check', 'checks'), '3 checks')
}) 

test('nextStep 沒東西時回空字串', () => {
	assert.equal(nextStep([]), '')
	assert.equal(nextStep([undefined, '']), '')
	assert.equal(nextStep(['repo_push(setUpstream:true)', 'repo_pr(action=create)']), 'next: repo_push(setUpstream:true) | repo_pr(action=create)')
}) 

test('section 與 bullets 的層次', () => {
	assert.equal(section('PR', ' #1 open'), 'PR:\n #1 open')
	assert.equal(section('PR', '  '), 'PR:\n(nothing)')
	assert.equal(bullets(['a', 'b']), '- a\n- b')
}) 

test('report 把空區塊收掉但不吃掉換行', () => {
	assert.equal(report('', 'a', undefined, 'b'), 'a\nb')
	assert.equal(report(['x', '', 'y']), 'x\ny')
}) 