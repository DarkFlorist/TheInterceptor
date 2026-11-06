import { inpageIsolation } from './inpageIsolation.mts'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const entrypoints = ['document_start', 'inpage', 'listenContentScript', 'listenContentScriptBootstrap']
const sources = entrypoints.map((name) => path.join(root, 'app/inpage/ts', `${ name }.ts`))
// Only this dependency-free identity helper may cross from extension source into the page world.
const approvedFiles = [...sources, path.join(root, 'app/ts/utils/browserProviderIdentity.ts')]
const result = await Bun.build({
	entrypoints: sources,
	plugins: [inpageIsolation(approvedFiles)],
	outdir: path.join(root, 'app/inpage/js'),
	target: 'browser',
	format: 'iife',
	naming: '[name].js',
	minify: false,
})
if (!result.success) throw new AggregateError(result.logs, 'Failed to bundle classic inpage scripts')
