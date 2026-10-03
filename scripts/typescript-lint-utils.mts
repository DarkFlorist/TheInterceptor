import ts from 'typescript'

export function scriptKindForPath(path: string) {
	if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
	return ts.ScriptKind.TS
}

export async function collectFilePaths(patterns: readonly string[], explicitPaths: readonly string[] = []) {
	if (explicitPaths.length > 0) return [...explicitPaths].sort()
	const filePaths = new Set<string>()
	for (const pattern of patterns) {
		for await (const path of new Bun.Glob(pattern).scan('.')) filePaths.add(path)
	}
	return [...filePaths].sort()
}
