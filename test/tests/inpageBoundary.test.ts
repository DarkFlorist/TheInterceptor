import * as assert from 'assert'
import { test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInpageBoundaryPlugin } from '../../build/inpage.mjs'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

test('inpage bundling admits curated helpers and rejects extension modules through transitive imports', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'interceptor-inpage-boundary-'))
	try {
		const entrypoint = path.join(directory, 'entry.ts')
		const dependency = path.join(directory, 'dependency.ts')
		await writeFile(entrypoint, 'import \'./dependency.js\'\n')
		await writeFile(dependency, `import { INTERCEPTOR_BRIDGE_REQUEST_MESSAGE } from ${ JSON.stringify(path.join(projectRoot, 'app/ts/utils/inpageBridgeProtocol.ts')) }\nconsole.log(INTERCEPTOR_BRIDGE_REQUEST_MESSAGE)\n`)
		const build = () => Bun.build({ entrypoints: [entrypoint], target: 'browser', format: 'iife', plugins: [createInpageBoundaryPlugin(directory)] })
		const allowed = await build()
		assert.equal(allowed.success, true, allowed.logs.map(String).join('\n'))
		await writeFile(dependency, `import { getSettings } from ${ JSON.stringify(path.join(projectRoot, 'app/ts/background/settings.ts')) }\nconsole.log(getSettings)\n`)
		await assert.rejects(build(), (error: unknown) => error instanceof AggregateError && error.errors.some((cause: unknown) => String(cause).includes('outside the inpage runtime boundary')))
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
