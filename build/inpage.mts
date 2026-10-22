import { readdir } from 'node:fs/promises'
import type { BunPlugin } from 'bun'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const inpageSourceDirectory = fileURLToPath(new URL('../app/inpage/ts/', import.meta.url))
const sharedSourceDirectory = fileURLToPath(new URL('../app/ts/utils/', import.meta.url))

// These helpers contain realm-neutral values only. Additions require an explicit boundary decision; privileged background, storage, UI, and package imports must fail the build.
const sharedModules = new Set([
	'bridgeBootstrapSecret.ts',
	'eip6963ProviderInfo.ts',
	'inpageBridgeProtocol.ts',
	'internalProviderMethods.ts',
	'signerIdentity.ts',
	'uuid.ts',
].map((file) => path.resolve(sharedSourceDirectory, file)))

export function createInpageBoundaryPlugin(sourceDirectory = inpageSourceDirectory): BunPlugin {
	const sourcePrefix = `${ path.resolve(sourceDirectory) }${ path.sep }`
	return {
		name: 'inpage-runtime-boundary',
		setup(builder) {
			builder.onLoad({ filter: /.*/ }, ({ path: modulePath }) => {
				const resolved = path.resolve(modulePath)
				if (resolved.startsWith(sourcePrefix) || sharedModules.has(resolved)) return
				throw new Error(`Module is outside the inpage runtime boundary: ${ resolved }`)
			})
		},
	}
}

if (import.meta.main) {
	// Bundle shared domain helpers into each classic content/inpage script; browsers must not resolve imports in the page realm.
	const sourceDirectory = new URL('../app/inpage/ts/', import.meta.url)
	const entrypoints = (await readdir(sourceDirectory)).filter((file) => file.endsWith('.ts')).map((file) => new URL(file, sourceDirectory).pathname)
	const result = await Bun.build({
		entrypoints,
		outdir: new URL('../app/inpage/js/', import.meta.url).pathname,
		target: 'browser',
		format: 'iife',
		minify: false,
		plugins: [createInpageBoundaryPlugin()],
	})
	if (!result.success) throw new AggregateError(result.logs, 'Failed to bundle inpage scripts')
}
