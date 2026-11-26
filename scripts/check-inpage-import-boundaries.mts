import * as path from 'node:path'
import ts from 'typescript'

const canonical = (file: string) => path.resolve(ts.sys.realpath?.(file) ?? file)
const inside = (file: string, directory: string) => {
	const relative = path.relative(directory, file)
	return relative !== '..' && !relative.startsWith(`..${ path.sep }`) && !path.isAbsolute(relative)
}

// Check source dependencies before bundling can erase imports. Shared dependencies may only depend on their own pure layer; neither layer may reach extension/UI code or packages.
export function assertInpageImportBoundaries(inpageDirectory: string, sharedDirectory: string, options: ts.CompilerOptions) {
	const inpageRoot = canonical(inpageDirectory)
	const sharedRoot = canonical(sharedDirectory)
	const pending = [inpageRoot, sharedRoot].flatMap((directory) => ts.sys.readDirectory(directory, ['.ts', '.tsx', '.mts', '.cts'], ['**/node_modules/**']))
	const visited = new Set<string>()
	const failures: string[] = []
	while (pending.length > 0) {
		const next = pending.pop()
		if (next === undefined) break
		const file = canonical(next)
		if (visited.has(file)) continue
		visited.add(file)
		const contents = ts.sys.readFile(file)
		if (contents === undefined) throw new Error(`Unable to read isolated source ${ file }`)
		const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
		const checkTarget = (specifier: string, target: string | undefined) => {
			const resolved = target === undefined ? undefined : canonical(target)
			if (resolved === undefined || !(inside(resolved, sharedRoot) || inside(file, inpageRoot) && inside(resolved, inpageRoot))) {
				failures.push(`${ file }: ${ specifier } resolves outside the isolated inpage/shared layers${ resolved === undefined ? '' : ` (${ resolved })` }`)
			} else pending.push(resolved)
		}
		const checkSpecifier = (node: ts.Node | undefined) => {
			if (node === undefined || !ts.isStringLiteralLike(node)) {
				failures.push(`${ file }: computed module loading is not allowed in the isolated layers`)
				return
			}
			checkTarget(node.text, ts.resolveModuleName(node.text, file, options, ts.sys).resolvedModule?.resolvedFileName)
		}
		const visit = (node: ts.Node) => {
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) checkSpecifier(node.moduleSpecifier)
			else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) checkSpecifier(node.moduleReference.expression)
			else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) checkSpecifier(node.argument.literal)
			else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) checkSpecifier(node.arguments[0])
			ts.forEachChild(node, visit)
		}
		visit(source)
		for (const reference of source.referencedFiles) checkTarget(reference.fileName, path.resolve(path.dirname(file), reference.fileName))
	}
	if (failures.length > 0) throw new Error(`Inpage dependency boundary violations:\n${ failures.join('\n') }`)
}

if (import.meta.main) {
	const config = ts.getParsedCommandLineOfConfigFile(path.resolve('tsconfig-inpage.json'), {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
	})
	if (config === undefined) throw new Error('Unable to read the inpage TypeScript project')
	if (config.errors.length > 0) throw new Error(config.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'))
	assertInpageImportBoundaries('app/inpage/ts', 'app/shared/ts', config.options)
}
