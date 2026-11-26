import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'bun:test'
import { removeObsoleteSharedArtifacts } from '../../scripts/shared-output-artifacts.mjs'

test('shared output cleanup removes renamed module artifacts while retaining current pairs and concurrent temporary files', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-shared-output-'))
	try {
		const current = ['protocol.js', 'protocol.d.ts', 'nested/transport.js', 'nested/transport.d.ts']
		const obsolete = ['oldProtocol.js', 'oldProtocol.d.ts', 'nested/oldTransport.js', 'nested/oldTransport.d.ts']
		const other = ['protocol.js.writer.tmp', 'README.txt']
		for (const file of [...current, ...obsolete, ...other]) {
			fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
			fs.writeFileSync(path.join(directory, file), file)
		}
		const emittedFiles = new Set(current.map((file) => path.join(directory, file)))
		removeObsoleteSharedArtifacts(directory, emittedFiles)
		removeObsoleteSharedArtifacts(directory, emittedFiles)
		for (const file of [...current, ...other]) assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), file)
		for (const file of obsolete) assert.equal(fs.existsSync(path.join(directory, file)), false)
	} finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
