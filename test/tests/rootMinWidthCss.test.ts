import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { readdir } from 'fs/promises'

async function readHtmlShells(directory: string) {
	const filenames = await readdir(directory)
	return await Promise.all(filenames
		.filter((filename) => filename.endsWith('.html'))
		.map(async (filename) => {
			const path = `${ directory }/${ filename }`
			return {
				path,
				text: await Bun.file(path).text(),
			}
		}))
}

describe('root page CSS', () => {
	test('does not restore Bulma root min-width', async () => {
		const css = await Bun.file('app/css/bulma.css').text()
		assert.doesNotMatch(css, /html\s*\{[\s\S]*?min-width\s*:\s*300px\s*;/)
	})

	test('does not add narrow tab page minimum widths back to HTML shells', async () => {
		const htmlShells = [
			...await readHtmlShells('app/html'),
			...await readHtmlShells('app/html3'),
		]
		for (const { path, text } of htmlShells) {
			if (path.endsWith('/popup.html') || path.endsWith('/popupV3.html')) continue
			assert.doesNotMatch(text, /min-width\s*:\s*(?:300|320)px\s*;/, path)
		}
	})

	test('simulation stack shells mount the app into a div root placeholder', async () => {
		const simulationStackShells = [
			'app/html/simulationStack.html',
			'app/html3/simulationStackV3.html',
		]
		for (const path of simulationStackShells) {
			const text = await Bun.file(path).text()
			assert.match(text, /<div id = 'simulation-stack-root'>Loading\.\.\.<\/div>/, path)
			assert.doesNotMatch(text, /<main id = 'simulation-stack-root'>/, path)
		}
	})
})
