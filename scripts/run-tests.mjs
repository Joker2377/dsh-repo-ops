/**
 * Run every test file in one process, in a fixed order.
 *
 * `node --test` starts a child process per file. That is the right thing on CI,
 * but in a confined desktop sandbox a child process cannot be created at all
 * (spawn fails with EPERM), so the suite would look broken on the very machine
 * the bundle is developed on. Importing each file registers its tests with
 * node:test in this process instead: same assertions, same exit code, no child.
 *
 * CI runs this script too, so the two paths cannot drift apart.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = fileURLToPath(new URL('../test/', import.meta.url))
const entries = await readdir(dir)
const files = entries.filter(name => name.endsWith('.test.mjs')).sort()

if (files.length === 0) {
	console.error('no test files found in test/')
	process.exitCode = 1
} else {
	for (const name of files) {
		console.log('')
		console.log('== ' + name)
		await import(pathToFileURL(join(dir, name)).href)
	}
	console.log('')
	if (process.exitCode) console.log('one or more test files failed')
	else console.log('all ' + files.length + ' test files ran')
}
