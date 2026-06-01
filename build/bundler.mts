import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import * as ts from 'typescript'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const appDirectory = path.join(directoryOfThisFile, '..', 'app')
const nodeModulesDirectory = path.join(
	directoryOfThisFile,
	'..',
	'node_modules',
)
const vendorDirectory = path.join(directoryOfThisFile, '..', 'app', 'vendor')
const vendoredDependencyMirrorDirectoryName = '__dependencies__'
const browserResolvedImports = {
	'webextension-polyfill': path.join(
		nodeModulesDirectory,
		'webextension-polyfill',
		'dist',
		'browser-polyfill.js',
	),
} as const
const resolvedImportCache = new Map<string, string | undefined>()
const packageJsonCache = new Map<string, PackageJson | undefined>()
const resolutionConditionPriority = [
	'browser',
	'import',
	'default',
	'module',
	'require',
] as const

type ModuleSpecifierOccurrence = {
	start: number
	end: number
	specifier: string
}

type BareImportIssue = {
	filePath: string
	specifier: string
}

type MissingRuntimeImportIssue = {
	filePath: string
	specifier: string
}

type ForbiddenRuntimeModuleIssue = {
	filePath: string
}

type PackageJson = {
	exports?: unknown
	module?: string
	main?: string
	browser?: string | Record<string, string | false>
	type?: string
}

function getRelativePath(from: string, to: string) {
	let relativePath = path.relative(from, to)
	if (
		relativePath === '' ||
		(!relativePath.startsWith('../') && !relativePath.startsWith('/'))
	) {
		relativePath = `./${relativePath || '.'}`
	}
	return relativePath
}

const isBareSpecifier = (specifier: string) =>
	!specifier.startsWith('.') &&
	!specifier.startsWith('/') &&
	!specifier.startsWith('node:') &&
	!specifier.startsWith('data:') &&
	!specifier.startsWith('file:')
const isInsideDirectory = (candidatePath: string, directoryPath: string) => {
	const relativePath = path.relative(directoryPath, candidatePath)
	return (
		relativePath === '' ||
		(!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
	)
}
const forbiddenRuntimeModules = new Set([
	path.join(vendorDirectory, 'viem', '_esm', 'utils', 'index.js'),
	path.join(vendorDirectory, 'viem', '_esm', 'ens', 'index.js'),
	path.join(vendorDirectory, 'viem', '_esm', 'accounts', 'index.js'),
])
const getResolverBasePath = (filePath: string) =>
	filePath.startsWith(`${vendorDirectory}${path.sep}`)
		? path.join(nodeModulesDirectory, path.relative(vendorDirectory, filePath))
		: filePath

const getPackageRootName = (specifier: string) =>
	specifier.startsWith('@')
		? specifier.split('/').slice(0, 2).join('/')
		: (specifier.split('/')[0] ?? specifier)

const getPackageSubpath = (specifier: string, packageRootName: string) =>
	specifier === packageRootName
		? '.'
		: `./${specifier.slice(packageRootName.length + 1)}`

function getVendoredLocationForNodeModulesPath(resolvedPath: string) {
	if (!isInsideDirectory(resolvedPath, nodeModulesDirectory)) return undefined
	const relativePathParts = path
		.relative(nodeModulesDirectory, resolvedPath)
		.split(path.sep)
	const nestedNodeModulesIndex = relativePathParts.indexOf('node_modules')
	if (nestedNodeModulesIndex === -1)
		return path.join(vendorDirectory, ...relativePathParts)
	const packagePathParts = relativePathParts.slice(0, nestedNodeModulesIndex)
	const dependencyPathParts = relativePathParts.slice(
		nestedNodeModulesIndex + 1,
	)
	if (packagePathParts.length === 0 || dependencyPathParts.length === 0)
		return undefined
	return path.join(
		vendorDirectory,
		...packagePathParts,
		vendoredDependencyMirrorDirectoryName,
		...dependencyPathParts,
	)
}

function readPackageJson(packageDirectory: string) {
	const packageJsonPath = path.join(packageDirectory, 'package.json')
	if (packageJsonCache.has(packageJsonPath))
		return packageJsonCache.get(packageJsonPath)
	try {
		const packageJson = JSON.parse(
			fs.readFileSync(packageJsonPath, 'utf8'),
		) as PackageJson
		packageJsonCache.set(packageJsonPath, packageJson)
		return packageJson
	} catch {
		packageJsonCache.set(packageJsonPath, undefined)
		return undefined
	}
}

const isPackageExportsSubpathMap = (
	packageExports: unknown,
): packageExports is Record<string, unknown> => {
	if (
		packageExports === null ||
		typeof packageExports !== 'object' ||
		Array.isArray(packageExports)
	)
		return false
	return Object.keys(packageExports).some((key) => key.startsWith('.'))
}

function selectExportTarget(exportValue: unknown): string | undefined {
	if (typeof exportValue === 'string') return exportValue
	if (Array.isArray(exportValue)) {
		for (const candidate of exportValue) {
			const selectedCandidate = selectExportTarget(candidate)
			if (selectedCandidate !== undefined) return selectedCandidate
		}
		return undefined
	}
	if (exportValue === null || typeof exportValue !== 'object') return undefined
	for (const condition of resolutionConditionPriority) {
		if (condition in exportValue) {
			const selectedCandidate = selectExportTarget(
				(exportValue as Record<string, unknown>)[condition],
			)
			if (selectedCandidate !== undefined) return selectedCandidate
		}
	}
	for (const [condition, candidate] of Object.entries(
		exportValue as Record<string, unknown>,
	)) {
		if (condition === 'types') continue
		const selectedCandidate = selectExportTarget(candidate)
		if (selectedCandidate !== undefined) return selectedCandidate
	}
	return undefined
}

function matchSubpathPattern(pattern: string, subpath: string) {
	const starIndex = pattern.indexOf('*')
	if (starIndex === -1) return undefined
	const prefix = pattern.slice(0, starIndex)
	const suffix = pattern.slice(starIndex + 1)
	if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return undefined
	return subpath.slice(prefix.length, subpath.length - suffix.length)
}

function resolvePackageExportsTarget(
	packageJson: PackageJson | undefined,
	subpath: string,
) {
	const packageExports = packageJson?.exports
	if (packageExports === undefined) return undefined
	if (!isPackageExportsSubpathMap(packageExports)) {
		if (subpath !== '.') return undefined
		return selectExportTarget(packageExports)
	}
	const exactMatch = packageExports[subpath]
	if (exactMatch !== undefined) return selectExportTarget(exactMatch)
	for (const [pattern, candidate] of Object.entries(packageExports)) {
		const patternMatch = matchSubpathPattern(pattern, subpath)
		if (patternMatch === undefined) continue
		const selectedCandidate = selectExportTarget(candidate)
		if (selectedCandidate === undefined) continue
		return selectedCandidate.replaceAll('*', patternMatch)
	}
	return undefined
}

function resolveExistingModuleFile(candidatePath: string) {
	const candidates = [
		candidatePath,
		`${candidatePath}.js`,
		`${candidatePath}.mjs`,
		`${candidatePath}.cjs`,
		path.join(candidatePath, 'index.js'),
		path.join(candidatePath, 'index.mjs'),
		path.join(candidatePath, 'index.cjs'),
	]
	return candidates.find((candidate) => fs.existsSync(candidate))
}

function getNodeModulesSearchDirectories(baseFilePath: string) {
	const searchDirectories: string[] = []
	let currentDirectory = path.dirname(baseFilePath)
	while (true) {
		searchDirectories.push(path.join(currentDirectory, 'node_modules'))
		const parentDirectory = path.dirname(currentDirectory)
		if (parentDirectory === currentDirectory) break
		currentDirectory = parentDirectory
	}
	return searchDirectories
}

function getPackageDirectoryCandidates(
	baseFilePath: string,
	packageRootName: string,
) {
	const packagePathParts = packageRootName.split('/')
	const candidates: string[] = []
	const seen = new Set<string>()
	for (const searchDirectory of getNodeModulesSearchDirectories(baseFilePath)) {
		const packageDirectory = path.join(searchDirectory, ...packagePathParts)
		if (seen.has(packageDirectory)) continue
		seen.add(packageDirectory)
		if (!fs.existsSync(path.join(packageDirectory, 'package.json'))) continue
		candidates.push(packageDirectory)
	}
	return candidates
}

function resolvePackageTarget(
	packageDirectory: string,
	packageTarget: string,
	baseFilePath: string,
) {
	if (isBareSpecifier(packageTarget))
		return resolvePackageSpecifierFromNodeModules(packageTarget, baseFilePath)
	const normalizedTarget =
		packageTarget.startsWith('./') || packageTarget.startsWith('../')
			? packageTarget
			: `./${packageTarget}`
	return resolveExistingModuleFile(
		path.resolve(packageDirectory, normalizedTarget),
	)
}

function resolvePackageSpecifierFromNodeModules(
	specifier: string,
	baseFilePath: string,
) {
	const packageRootName = getPackageRootName(specifier)
	const packageSubpath = getPackageSubpath(specifier, packageRootName)
	for (const packageDirectory of getPackageDirectoryCandidates(
		baseFilePath,
		packageRootName,
	)) {
		const packageJson = readPackageJson(packageDirectory)
		const exportTarget = resolvePackageExportsTarget(
			packageJson,
			packageSubpath,
		)
		if (exportTarget !== undefined) {
			const resolvedExportTarget = resolvePackageTarget(
				packageDirectory,
				exportTarget,
				path.join(packageDirectory, 'package.json'),
			)
			if (resolvedExportTarget !== undefined) return resolvedExportTarget
		}
		if (packageSubpath === '.') {
			const rootTarget =
				packageJson?.module ??
				(typeof packageJson?.browser === 'string'
					? packageJson.browser
					: undefined) ??
				packageJson?.main
			if (rootTarget !== undefined) {
				const resolvedRootTarget = resolvePackageTarget(
					packageDirectory,
					rootTarget,
					path.join(packageDirectory, 'package.json'),
				)
				if (resolvedRootTarget !== undefined) return resolvedRootTarget
			}
		}
		const resolvedFallbackTarget = resolvePackageTarget(
			packageDirectory,
			packageSubpath === '.' ? './index.js' : packageSubpath,
			path.join(packageDirectory, 'package.json'),
		)
		if (resolvedFallbackTarget !== undefined) return resolvedFallbackTarget
	}
	return undefined
}

function getModuleSpecifierOccurrences(
	filePath: string,
	text: string,
): readonly ModuleSpecifierOccurrence[] {
	const sourceFile = ts.createSourceFile(
		filePath,
		text,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	)
	const occurrences: ModuleSpecifierOccurrence[] = []
	const addOccurrence = (moduleSpecifier: ts.StringLiteralLike) =>
		occurrences.push({
			start: moduleSpecifier.getStart(sourceFile),
			end: moduleSpecifier.getEnd(),
			specifier: moduleSpecifier.text,
		})

	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			addOccurrence(node.moduleSpecifier)
		}
		if (ts.isCallExpression(node)) {
			const [firstArgument] = node.arguments
			if (
				firstArgument !== undefined &&
				ts.isStringLiteralLike(firstArgument)
			) {
				if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
					addOccurrence(firstArgument)
				if (
					ts.isIdentifier(node.expression) &&
					node.expression.text === 'require'
				)
					addOccurrence(firstArgument)
			}
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return occurrences.sort((left, right) => left.start - right.start)
}

const getVendoredImportPath = (filePath: string, specifier: string) => {
	if (!isBareSpecifier(specifier)) return undefined
	try {
		const cacheKey = `${filePath}\0${specifier}`
		const cachedPath = resolvedImportCache.get(cacheKey)
		if (cachedPath !== undefined || resolvedImportCache.has(cacheKey))
			return cachedPath
		const basePath = getResolverBasePath(filePath)
		const resolvedPath =
			browserResolvedImports[
				specifier as keyof typeof browserResolvedImports
			] ?? resolvePackageSpecifierFromNodeModules(specifier, basePath)
		if (resolvedPath === undefined) {
			resolvedImportCache.set(cacheKey, undefined)
			return undefined
		}
		const newLocation = (() => {
			if (isInsideDirectory(resolvedPath, vendorDirectory)) return resolvedPath
			if (isInsideDirectory(resolvedPath, nodeModulesDirectory))
				return getVendoredLocationForNodeModulesPath(resolvedPath)
			return undefined
		})()
		if (newLocation === undefined) {
			resolvedImportCache.set(cacheKey, undefined)
			return undefined
		}
		const vendoredImportPath = getRelativePath(
			path.dirname(filePath),
			newLocation,
		).replace(/\\/g, '/')
		resolvedImportCache.set(cacheKey, vendoredImportPath)
		return vendoredImportPath
	} catch {
		return undefined
	}
}

function getRewrittenRelativeImportPath(filePath: string, specifier: string) {
	if (
		isBareSpecifier(specifier) ||
		!isInsideDirectory(filePath, vendorDirectory)
	)
		return undefined
	if (specifier.startsWith('/')) return undefined
	const basePath = getResolverBasePath(filePath)
	const resolvedPath = resolveExistingModuleFile(
		path.resolve(path.dirname(basePath), specifier),
	)
	if (resolvedPath === undefined) return undefined
	const vendoredLocation = getVendoredLocationForNodeModulesPath(resolvedPath)
	if (vendoredLocation === undefined) return undefined
	const vendoredImportPath = getRelativePath(
		path.dirname(filePath),
		vendoredLocation,
	).replace(/\\/g, '/')
	return vendoredImportPath === specifier ? undefined : vendoredImportPath
}

function getBareImportIssues(
	filePath: string,
	text: string,
): BareImportIssue[] {
	return getModuleSpecifierOccurrences(filePath, text)
		.filter(({ specifier }) => isBareSpecifier(specifier))
		.map(({ specifier }) => ({ filePath, specifier }))
}

export function replaceImport(filePath: string, text: string) {
	let replaced = text
	const occurrences = getModuleSpecifierOccurrences(filePath, text)
	for (let index = occurrences.length - 1; index >= 0; index--) {
		const occurrence = occurrences[index]
		if (occurrence === undefined) continue
		const vendoredImportPath =
			getVendoredImportPath(filePath, occurrence.specifier) ??
			getRewrittenRelativeImportPath(filePath, occurrence.specifier)
		if (vendoredImportPath === undefined) continue
		const quote = text[occurrence.start]
		replaced = `${replaced.slice(0, occurrence.start)}${quote}${vendoredImportPath}${quote}${replaced.slice(occurrence.end)}`
	}
	return replaced
}

function getFiles(topDir: string): string[] {
	const filePaths: string[] = []
	for (const dir of fs.readdirSync(topDir, { withFileTypes: true })) {
		const resolvedPath = path.resolve(topDir, dir.name)
		if (dir.isDirectory()) {
			filePaths.push(...getFiles(resolvedPath))
			continue
		}
		filePaths.push(resolvedPath)
	}
	return filePaths
}

function ensureDirectoryExists(dir: string) {
	fs.mkdirSync(dir, { recursive: true })
}

function formatBunBuildLogs(logs: readonly BuildMessage[]) {
	return logs.map((log) => log.message).join('\n')
}

const runtimeEntrypointPaths = [
	path.join(appDirectory, 'js', 'backgroundServiceWorker.js'),
	path.join(appDirectory, 'js', 'background', 'background-startup.js'),
	path.join(appDirectory, 'js', 'addressBookRender.js'),
	path.join(appDirectory, 'js', 'changeChain.js'),
	path.join(appDirectory, 'js', 'confirmTransaction.js'),
	path.join(appDirectory, 'js', 'fetchSimulationStack.js'),
	path.join(appDirectory, 'js', 'interceptorAccess.js'),
	path.join(appDirectory, 'js', 'popup.js'),
	path.join(appDirectory, 'js', 'settingsView.js'),
	path.join(appDirectory, 'js', 'websiteAccess.js'),
	path.join(appDirectory, 'inpage', 'js', 'document_start.js'),
	path.join(appDirectory, 'inpage', 'js', 'inpage.js'),
	path.join(appDirectory, 'inpage', 'js', 'listenContentScript.js'),
	path.join(appDirectory, 'js', 'utils', 'viem.js'),
]

function getExistingRuntimeEntrypointPaths() {
	return runtimeEntrypointPaths.filter((entrypointPath) =>
		fs.existsSync(entrypointPath),
	)
}

async function bundleChromeRuntimeEntrypoints() {
	const existingEntrypoints = getExistingRuntimeEntrypointPaths()
	if (existingEntrypoints.length === 0) return
	const bundledOutputDirectory = path.join(appDirectory, '.runtime-bundles')
	fs.rmSync(bundledOutputDirectory, { recursive: true, force: true })
	ensureDirectoryExists(bundledOutputDirectory)
	const buildResult = await Bun.build({
		entrypoints: existingEntrypoints,
		outdir: bundledOutputDirectory,
		root: appDirectory,
		target: 'browser',
		format: 'esm',
		splitting: false,
		sourcemap: 'external',
	})
	if (!buildResult.success) {
		throw new Error(
			`Failed to bundle Chrome runtime entrypoints with Bun:\n${formatBunBuildLogs(buildResult.logs)}`,
		)
	}
	for (const entrypointPath of existingEntrypoints) {
		const relativeEntrypointPath = path.relative(appDirectory, entrypointPath)
		const bundledEntrypointPath = path.join(
			bundledOutputDirectory,
			relativeEntrypointPath,
		)
		const bundledEntrypointMapPath = `${bundledEntrypointPath}.map`
		if (!fs.existsSync(bundledEntrypointPath)) {
			throw new Error(
				`Bundled entrypoint was not written by Bun: ${relativeEntrypointPath.replace(/\\/g, '/')}`,
			)
		}
		fs.copyFileSync(bundledEntrypointPath, entrypointPath)
		if (fs.existsSync(bundledEntrypointMapPath))
			fs.copyFileSync(bundledEntrypointMapPath, `${entrypointPath}.map`)
	}
	fs.rmSync(bundledOutputDirectory, { recursive: true, force: true })
}

function getRuntimeFiles() {
	return [
		path.join(directoryOfThisFile, '..', 'app', 'js'),
		path.join(directoryOfThisFile, '..', 'app', 'vendor'),
	]
}

function resolveRuntimeImportedFilePath(filePath: string, specifier: string) {
	const unresolvedPath = specifier.startsWith('/')
		? path.join(appDirectory, specifier.slice(1))
		: path.resolve(path.dirname(filePath), specifier)
	return resolveExistingModuleFile(unresolvedPath)
}

function formatBareImportIssues(bareImportIssues: readonly BareImportIssue[]) {
	return bareImportIssues
		.map(
			({ filePath, specifier }) =>
				`${path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/')}: ${specifier}`,
		)
		.join('\n')
}

function formatMissingRuntimeImportIssues(
	missingRuntimeImportIssues: readonly MissingRuntimeImportIssue[],
) {
	return missingRuntimeImportIssues
		.map(
			({ filePath, specifier }) =>
				`${path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/')}: ${specifier}`,
		)
		.join('\n')
}

function collectRuntimeDependencyGraph() {
	const visited = new Set<string>()
	const missingRuntimeImportIssues = new Map<
		string,
		MissingRuntimeImportIssue
	>()
	const runtimeEntryFiles = getExistingRuntimeEntrypointPaths()
	const pendingFiles = [...runtimeEntryFiles]
	while (pendingFiles.length > 0) {
		const filePath = pendingFiles.pop()
		if (filePath === undefined || visited.has(filePath)) continue
		visited.add(filePath)
		const text = fs.readFileSync(filePath, 'utf8')
		for (const occurrence of getModuleSpecifierOccurrences(filePath, text)) {
			if (
				!occurrence.specifier.startsWith('.') &&
				!occurrence.specifier.startsWith('/')
			)
				continue
			const importedFilePath = resolveRuntimeImportedFilePath(
				filePath,
				occurrence.specifier,
			)
			if (importedFilePath === undefined) {
				const issueKey = `${filePath}\0${occurrence.specifier}`
				if (!missingRuntimeImportIssues.has(issueKey)) {
					missingRuntimeImportIssues.set(issueKey, {
						filePath,
						specifier: occurrence.specifier,
					})
				}
				continue
			}
			pendingFiles.push(importedFilePath)
		}
	}
	return {
		files: [...visited],
		missingRuntimeImportIssues: [...missingRuntimeImportIssues.values()],
	}
}

export function findBareImportsInRuntimeFiles() {
	const bareImportIssues: BareImportIssue[] = []
	for (const filePath of collectRuntimeDependencyGraph().files) {
		const text = fs.readFileSync(filePath, 'utf8')
		bareImportIssues.push(...getBareImportIssues(filePath, text))
	}
	return bareImportIssues
}

export function findMissingRuntimeImportsInRuntimeFiles() {
	return collectRuntimeDependencyGraph().missingRuntimeImportIssues
}

export function isBrowserIncompatibleRuntimeModule(filePath: string) {
	return forbiddenRuntimeModules.has(filePath)
}

function formatForbiddenRuntimeModuleIssues(
	forbiddenRuntimeModuleIssues: readonly ForbiddenRuntimeModuleIssue[],
) {
	return forbiddenRuntimeModuleIssues
		.map(
			({ filePath }) =>
				`${path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/')}: do not import the viem barrel entrypoint in MV3 runtime code`,
		)
		.join('\n')
}

export function findForbiddenRuntimeModulesInRuntimeFiles() {
	return collectRuntimeDependencyGraph()
		.files.filter(isBrowserIncompatibleRuntimeModule)
		.map((filePath) => ({ filePath }))
}

export async function replaceImportsInJSFiles() {
	await bundleChromeRuntimeEntrypoints()
	for (const folder of getRuntimeFiles()) {
		ensureDirectoryExists(folder)
		for (const filePath of getFiles(folder)) {
			if (path.extname(filePath) !== '.js' && path.extname(filePath) !== '.mjs')
				continue
			const replaced = replaceImport(
				filePath,
				fs.readFileSync(filePath, 'utf8'),
			)
			fs.writeFileSync(filePath, replaced)
		}
	}
	const missingRuntimeImportIssues = findMissingRuntimeImportsInRuntimeFiles()
	const bareImportIssues = findBareImportsInRuntimeFiles()
	const forbiddenRuntimeModuleIssues =
		findForbiddenRuntimeModulesInRuntimeFiles()
	if (missingRuntimeImportIssues.length > 0) {
		throw new Error(
			`Runtime modules import missing files after bundling:\n${formatMissingRuntimeImportIssues(missingRuntimeImportIssues)}`,
		)
	}
	if (bareImportIssues.length > 0) {
		throw new Error(
			`Unresolved bare module specifiers remain after bundling:\n${formatBareImportIssues(bareImportIssues)}`,
		)
	}
	if (forbiddenRuntimeModuleIssues.length > 0) {
		throw new Error(
			`Browser-incompatible runtime modules remain after bundling:\n${formatForbiddenRuntimeModuleIssues(forbiddenRuntimeModuleIssues)}`,
		)
	}
}

if (import.meta.main) {
	try {
		await replaceImportsInJSFiles()
	} catch (error) {
		console.error(error)
		process.exit(1)
	}
}
