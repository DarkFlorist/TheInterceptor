import * as path from 'node:path'
import * as fs from 'node:fs'
import ts from 'typescript'
import { removeObsoleteSharedArtifacts, writeCompilerOutputAtomically } from './shared-output-artifacts.mjs'

// TypeScript's solution builder owns dependency ordering; consumer sources always name the shared source rather than its generated declarations.
export function compileTypeScriptProject(configFile: string) {
	const reportDiagnostic = (diagnostic: ts.Diagnostic) => {
		process.stderr.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			getNewLine: () => '\n',
		}))
	}
	const host = ts.createSolutionBuilderHost(ts.sys, undefined, reportDiagnostic)
	host.writeFile = writeCompilerOutputAtomically
	const result = ts.createSolutionBuilder(host, [path.resolve(configFile)], {}).build()
	if (result !== 0) return result
	const pending = [path.resolve(configFile)]
	const visited = new Set<string>()
	while (pending.length > 0) {
		const current = pending.pop()
		if (current === undefined || visited.has(current)) continue
		visited.add(current)
		const project = ts.getParsedCommandLineOfConfigFile(current, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: reportDiagnostic })
		if (project === undefined) throw new Error(`Unable to read built TypeScript project: ${ current }`)
		for (const reference of project.projectReferences ?? []) pending.push(ts.resolveProjectReferencePath(reference))
		if (!project.options.composite || project.options.outDir === undefined || !fs.existsSync(project.options.outDir)) continue
		// Incremental builds can emit nothing. Derive current artifacts from the source graph so a no-op build never deletes its own outputs.
		const expectedFiles = new Set(project.fileNames.flatMap((file) => ts.getOutputFileNames(project, file, false)))
		removeObsoleteSharedArtifacts(project.options.outDir, expectedFiles)
	}
	return result
}

if (import.meta.main) {
	const configFile = process.argv[2]
	if (configFile === undefined) throw new Error('Pass the TypeScript build configuration to compile.')
	process.exitCode = compileTypeScriptProject(configFile)
}
