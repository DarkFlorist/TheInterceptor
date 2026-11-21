import type { BunPlugin } from 'bun'
import { realpathSync } from 'node:fs'
import * as ts from 'typescript'

/** Every runtime dependency in the page-world bundle must be explicitly reviewed here by its caller. */
export function inpageIsolation(approvedFiles: readonly string[]): BunPlugin {
	const approved = new Set(approvedFiles.map((file) => realpathSync(file)))
	return {
		name: 'inpage-dependency-isolation',
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => {
				const resolved = realpathSync(Bun.resolveSync(args.path, args.resolveDir || process.cwd()))
				if (!approved.has(resolved)) throw new Error(`Unapproved inpage dependency: ${ resolved }`)
				return { path: resolved }
			})
			builder.onLoad({ filter: /.*/ }, async (args) => {
				if (!approved.has(realpathSync(args.path))) throw new Error(`Unapproved inpage source: ${ args.path }`)
				const contents = await Bun.file(args.path).text()
				const source = ts.createSourceFile(args.path, contents, ts.ScriptTarget.Latest, true)
				function check(node: ts.Node): void {
					// The closed graph permits static ES imports only; runtime loading cannot bypass the resolver.
					if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))) {
						throw new Error(`Runtime module loading is forbidden in inpage source: ${ args.path }`)
					}
					ts.forEachChild(node, check)
				}
				check(source)
				return { contents, loader: 'ts' }
			})
		},
	}
}
