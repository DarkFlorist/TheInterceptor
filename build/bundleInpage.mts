import * as path from 'node:path'

const result = await Bun.build({
	entrypoints: ['inpage', 'document_start', 'listenContentScript', 'listenContentScriptBootstrap'].map((name) => path.resolve(`app/inpage/ts/${ name }.ts`)),
	outdir: path.resolve('app/inpage/js'),
	target: 'browser',
	format: 'iife',
	splitting: false,
})
if (!result.success) throw new AggregateError(result.logs, 'Failed to bundle injected scripts')
