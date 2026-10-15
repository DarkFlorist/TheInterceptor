import { readdir } from 'node:fs/promises'

// Bundle shared domain helpers into each classic content/inpage script; browsers must not resolve imports in the page realm.
const sourceDirectory = new URL('../app/inpage/ts/', import.meta.url)
const entrypoints = (await readdir(sourceDirectory)).filter((file) => file.endsWith('.ts')).map((file) => new URL(file, sourceDirectory).pathname)
const result = await Bun.build({
	entrypoints,
	outdir: new URL('../app/inpage/js/', import.meta.url).pathname,
	target: 'browser',
	format: 'iife',
	minify: false,
})
if (!result.success) throw new AggregateError(result.logs, 'Failed to bundle inpage scripts')
