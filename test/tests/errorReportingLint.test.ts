import * as assert from 'assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'bun:test'

const repositoryRoot = process.cwd()

type ScriptResult = {
	exitCode: number
	stderr: string
	stdout: string
}

async function runUnexpectedErrorReportingLint(sourceText: string): Promise<ScriptResult> {
	const directory = await mkdtemp(path.join(tmpdir(), 'interceptor-error-lint-'))
	const fixturePath = path.join(directory, 'fixture.ts')
	await writeFile(fixturePath, sourceText)
	try {
		const process = Bun.spawn(['bun', './scripts/check-awaited-unexpected-error-reporting.mts', fixturePath], {
			cwd: repositoryRoot,
			stderr: 'pipe',
			stdout: 'pipe',
		})
		const [exitCode, stderr, stdout] = await Promise.all([
			process.exited,
			process.stderr === undefined ? '' : new Response(process.stderr).text(),
			process.stdout === undefined ? '' : new Response(process.stdout).text(),
		])
		return { exitCode, stderr, stdout }
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

describe('unexpected error reporting lint', () => {
	test('allows awaited returned and voided reportUnexpectedError calls', async () => {
		const result = await runUnexpectedErrorReportingLint(`
			async function sample(error: unknown) {
				await reportUnexpectedError(error)
				void reportUnexpectedError(error)
				return reportUnexpectedError(error)
				await (reportUnexpectedError(error))
				void (reportUnexpectedError(error))
				return (reportUnexpectedError(error))
			}
		`)

		assert.equal(result.exitCode, 0, result.stderr)
	})

	test('rejects multiline unhandled reportUnexpectedError calls', async () => {
		const result = await runUnexpectedErrorReportingLint(`
			async function sample(error: unknown) {
				reportUnexpectedError(
					error
				)
			}
		`)

		assert.notEqual(result.exitCode, 0)
		assert.equal(result.stderr.includes('reportUnexpectedError calls must be awaited, returned, or explicitly voided.'), true)
	})

	test('rejects multiline wrapped reportUnexpectedError calls', async () => {
		const result = await runUnexpectedErrorReportingLint(`
			async function sample() {
				await reportUnexpectedError(
					new Error('wrapped')
				)
			}
		`)

		assert.notEqual(result.exitCode, 0)
		assert.equal(result.stderr.includes('Do not wrap errors before reporting.'), true)
	})
})
