import * as fs from 'node:fs'
import * as path from 'node:path'

// App and inpage builds share a referenced project and may run concurrently. Publish complete deterministic files before either consumer reads them.
export function writeCompilerOutputAtomically(fileName: string, contents: string, writeByteOrderMark = false) {
	fs.mkdirSync(path.dirname(fileName), { recursive: true })
	const temporary = `${ fileName }.${ process.pid }.${ crypto.randomUUID() }.tmp`
	fs.writeFileSync(temporary, `${ writeByteOrderMark ? '\uFEFF' : '' }${ contents }`)
	fs.renameSync(temporary, fileName)
}

// Remove artifacts whose source disappeared, without deleting current files that concurrent app/inpage compilers may be reading.
export function removeObsoleteSharedArtifacts(outputDirectory: string, expectedFiles: ReadonlySet<string>) {
	for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
		const file = path.join(outputDirectory, entry.name)
		if (entry.isDirectory()) removeObsoleteSharedArtifacts(file, expectedFiles)
		else if ((entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) && !expectedFiles.has(path.resolve(file))) fs.rmSync(file, { force: true })
	}
}
