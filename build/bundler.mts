import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import * as ts from 'typescript'

const directoryOfThisFile = path.dirname(url.fileURLToPath(import.meta.url))
const appDirectory = path.join(directoryOfThisFile, '..', 'app')
const nodeModulesDirectory = path.join(directoryOfThisFile, '..', 'node_modules')
const vendorDirectory = path.join(directoryOfThisFile, '..', 'app', 'vendor')
const vendoredDependencyMirrorDirectoryName = '__dependencies__'
const browserResolvedImports = {
	'webextension-polyfill': path.join(nodeModulesDirectory, 'webextension-polyfill', 'dist', 'browser-polyfill.js'),
} as const
const externalRuntimeModules = ['webextension-polyfill'] as const
const resolvedImportCache = new Map<string, string | undefined>()
const packageJsonCache = new Map<string, PackageJson | undefined>()
const resolutionConditionPriority = ['browser', 'import', 'default', 'module', 'require'] as const

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

type RuntimeImportProcessor = (filePath: string, text: string, occurrences: readonly ModuleSpecifierOccurrence[]) => readonly string[]

type PackageJson = {
	exports?: unknown
	module?: string
	main?: string
	browser?: string | Record<string, string | false>
	type?: string
}

function getRelativePath(from: string, to: string) {
	let relativePath = path.relative(from, to)
	if (relativePath === '' || (!relativePath.startsWith('../') && !relativePath.startsWith('/'))) {
		relativePath = `./${ relativePath || '.' }`
	}
	return relativePath
}

const isBareSpecifier = (specifier: string) => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('data:') && !specifier.startsWith('file:')
const isInsideDirectory = (candidatePath: string, directoryPath: string) => {
	const relativePath = path.relative(directoryPath, candidatePath)
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}
const forbiddenRuntimeModules = new Set([
	path.join(vendorDirectory, 'viem', '_esm', 'utils', 'index.js'),
	path.join(vendorDirectory, 'viem', '_esm', 'ens', 'index.js'),
	path.join(vendorDirectory, 'viem', '_esm', 'accounts', 'index.js'),
])
const requiredRuntimeAssetPaths = new Set([
	path.join(vendorDirectory, 'webextension-polyfill', 'dist', 'browser-polyfill.js'),
])
const requiredImportedRuntimeAssetPaths = new Set([
	path.join(vendorDirectory, 'webextension-polyfill', 'dist', 'browser-polyfill.js'),
])
const addressMetadataImagesDirectory = path.join(vendorDirectory, '@darkflorist', 'address-metadata', 'images')
const getResolverBasePath = (filePath: string) => filePath.startsWith(`${ vendorDirectory }${ path.sep }`)
	? path.join(nodeModulesDirectory, path.relative(vendorDirectory, filePath))
	: filePath

const getPackageRootName = (specifier: string) => specifier.startsWith('@')
	? specifier.split('/').slice(0, 2).join('/')
	: specifier.split('/')[0] ?? specifier

const getPackageSubpath = (specifier: string, packageRootName: string) => specifier === packageRootName
	? '.'
	: `./${ specifier.slice(packageRootName.length + 1) }`

function getPackageSpecifierFromNodeModulesPathParts(pathParts: readonly string[]) {
	const nodeModulesIndex = pathParts.indexOf('node_modules')
	if (nodeModulesIndex === -1) return undefined
	const dependencyPathParts = pathParts.slice(nodeModulesIndex + 1)
	const firstPathPart = dependencyPathParts[0]
	if (firstPathPart === undefined) return undefined
	if (!firstPathPart.startsWith('@')) return dependencyPathParts.join('/')
	const secondPathPart = dependencyPathParts[1]
	if (secondPathPart === undefined) return undefined
	return dependencyPathParts.slice(0, 2).join('/') + (dependencyPathParts.length > 2 ? `/${ dependencyPathParts.slice(2).join('/') }` : '')
}

function getPackageSpecifierFromRelativeNodeModulesImport(specifier: string) {
	return getPackageSpecifierFromNodeModulesPathParts(specifier.split(/[\\/]+/))
}

function getVendoredLocationForNodeModulesPath(resolvedPath: string) {
	if (!isInsideDirectory(resolvedPath, nodeModulesDirectory)) return undefined
	const relativePathParts = path.relative(nodeModulesDirectory, resolvedPath).split(path.sep)
	const nestedNodeModulesIndex = relativePathParts.indexOf('node_modules')
	if (nestedNodeModulesIndex === -1) return path.join(vendorDirectory, ...relativePathParts)
	const packagePathParts = relativePathParts.slice(0, nestedNodeModulesIndex)
	const dependencyPathParts = relativePathParts.slice(nestedNodeModulesIndex + 1)
	if (packagePathParts.length === 0 || dependencyPathParts.length === 0) return undefined
	return path.join(vendorDirectory, ...packagePathParts, vendoredDependencyMirrorDirectoryName, ...dependencyPathParts)
}

function readPackageJson(packageDirectory: string) {
	const packageJsonPath = path.join(packageDirectory, 'package.json')
	if (packageJsonCache.has(packageJsonPath)) return packageJsonCache.get(packageJsonPath)
	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson
		packageJsonCache.set(packageJsonPath, packageJson)
		return packageJson
	} catch {
		packageJsonCache.set(packageJsonPath, undefined)
		return undefined
	}
}

const isPackageExportsSubpathMap = (packageExports: unknown): packageExports is Record<string, unknown> => {
	if (packageExports === null || typeof packageExports !== 'object' || Array.isArray(packageExports)) return false
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
			const selectedCandidate = selectExportTarget((exportValue as Record<string, unknown>)[condition])
			if (selectedCandidate !== undefined) return selectedCandidate
		}
	}
	for (const [condition, candidate] of Object.entries(exportValue as Record<string, unknown>)) {
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

function resolvePackageExportsTarget(packageJson: PackageJson | undefined, subpath: string) {
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
		`${ candidatePath }.js`,
		`${ candidatePath }.mjs`,
		`${ candidatePath }.cjs`,
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

function getPackageDirectoryCandidates(baseFilePath: string, packageRootName: string) {
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

function resolvePackageTarget(packageDirectory: string, packageTarget: string, baseFilePath: string) {
	if (isBareSpecifier(packageTarget)) return resolvePackageSpecifierFromNodeModules(packageTarget, baseFilePath)
	const normalizedTarget = packageTarget.startsWith('./') || packageTarget.startsWith('../')
		? packageTarget
		: `./${ packageTarget }`
	return resolveExistingModuleFile(path.resolve(packageDirectory, normalizedTarget))
}

function resolvePackageSpecifierFromNodeModules(specifier: string, baseFilePath: string) {
	const packageRootName = getPackageRootName(specifier)
	const packageSubpath = getPackageSubpath(specifier, packageRootName)
	for (const packageDirectory of getPackageDirectoryCandidates(baseFilePath, packageRootName)) {
		const packageJson = readPackageJson(packageDirectory)
		const exportTarget = resolvePackageExportsTarget(packageJson, packageSubpath)
		if (exportTarget !== undefined) {
			const resolvedExportTarget = resolvePackageTarget(packageDirectory, exportTarget, path.join(packageDirectory, 'package.json'))
			if (resolvedExportTarget !== undefined) return resolvedExportTarget
		}
		if (packageSubpath === '.') {
			const rootTarget = packageJson?.module
				?? (typeof packageJson?.browser === 'string' ? packageJson.browser : undefined)
				?? packageJson?.main
			if (rootTarget !== undefined) {
				const resolvedRootTarget = resolvePackageTarget(packageDirectory, rootTarget, path.join(packageDirectory, 'package.json'))
				if (resolvedRootTarget !== undefined) return resolvedRootTarget
			}
		}
		const resolvedFallbackTarget = resolvePackageTarget(packageDirectory, packageSubpath === '.' ? './index.js' : packageSubpath, path.join(packageDirectory, 'package.json'))
		if (resolvedFallbackTarget !== undefined) return resolvedFallbackTarget
	}
	return undefined
}

function getStringLiteralContentEnd(text: string, openingDelimiterIndex: number) {
	const openingDelimiter = text[openingDelimiterIndex]
	if (openingDelimiter !== '\'' && openingDelimiter !== '"' && openingDelimiter !== '`') {
		throw new Error(`Expected a module specifier string delimiter at offset ${ openingDelimiterIndex }`)
	}
	let escaped = false
	for (let index = openingDelimiterIndex + 1; index < text.length; index++) {
		const character = text[index]
		if (escaped) {
			escaped = false
			continue
		}
		if (character === '\\') {
			escaped = true
			continue
		}
		if (character === openingDelimiter) return index
	}
	throw new Error(`Module specifier string at offset ${ openingDelimiterIndex } has no closing delimiter`)
}

function getModuleSpecifierOccurrences(text: string): readonly ModuleSpecifierOccurrence[] {
	const occurrences = ts.preProcessFile(text, true, false).importedFiles
		.map((importedFile): ModuleSpecifierOccurrence => {
			const start = importedFile.pos + 1
			return {
				start,
				end: getStringLiteralContentEnd(text, importedFile.pos),
				specifier: importedFile.fileName,
			}
		})
	if (!/\brequire\s*\(/u.test(text)) return occurrences
	const sourceFile = ts.createSourceFile('runtime.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
			const [firstArgument] = node.arguments
			if (firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)) {
				occurrences.push({
					start: firstArgument.getStart(sourceFile) + 1,
					end: firstArgument.getEnd() - 1,
					specifier: firstArgument.text,
				})
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
		const cacheKey = `${ filePath }\0${ specifier }`
		const cachedPath = resolvedImportCache.get(cacheKey)
		if (cachedPath !== undefined || resolvedImportCache.has(cacheKey)) return cachedPath
		const basePath = getResolverBasePath(filePath)
		const resolvedPath = browserResolvedImports[specifier as keyof typeof browserResolvedImports] ?? resolvePackageSpecifierFromNodeModules(specifier, basePath)
		if (resolvedPath === undefined) {
			resolvedImportCache.set(cacheKey, undefined)
			return undefined
		}
		const newLocation = (() => {
			if (isInsideDirectory(resolvedPath, vendorDirectory)) return resolvedPath
			if (isInsideDirectory(resolvedPath, nodeModulesDirectory)) return getVendoredLocationForNodeModulesPath(resolvedPath)
			return undefined
		})()
		if (newLocation === undefined) {
			resolvedImportCache.set(cacheKey, undefined)
			return undefined
		}
		const vendoredImportPath = getRelativePath(path.dirname(filePath), newLocation).replace(/\\/g, '/')
		resolvedImportCache.set(cacheKey, vendoredImportPath)
		return vendoredImportPath
	} catch {
		return undefined
	}
}

function getRewrittenRelativeImportPath(filePath: string, specifier: string) {
	if (isBareSpecifier(specifier) || !isInsideDirectory(filePath, vendorDirectory)) return undefined
	if (specifier.startsWith('/')) return undefined
	const basePath = getResolverBasePath(filePath)
	const resolvedPath = resolveExistingModuleFile(path.resolve(path.dirname(basePath), specifier))
	const fallbackResolvedPath = resolvedPath ?? (() => {
		const nodeModulesPackageSpecifier = getPackageSpecifierFromRelativeNodeModulesImport(specifier)
		if (nodeModulesPackageSpecifier === undefined) return undefined
		return resolvePackageSpecifierFromNodeModules(nodeModulesPackageSpecifier, basePath)
	})()
	if (fallbackResolvedPath === undefined) return undefined
	const vendoredLocation = getVendoredLocationForNodeModulesPath(fallbackResolvedPath)
	if (vendoredLocation === undefined) return undefined
	const vendoredImportPath = getRelativePath(path.dirname(filePath), vendoredLocation).replace(/\\/g, '/')
	return vendoredImportPath === specifier ? undefined : vendoredImportPath
}

function rewriteModuleSpecifiers(filePath: string, text: string, occurrences = getModuleSpecifierOccurrences(text)) {
	let rewrittenText = text
	const rewrittenSpecifiers = occurrences.map((occurrence) => getVendoredImportPath(filePath, occurrence.specifier)
		?? getRewrittenRelativeImportPath(filePath, occurrence.specifier)
		?? occurrence.specifier)
	for (let index = occurrences.length - 1; index >= 0; index--) {
		const occurrence = occurrences[index]
		const rewrittenSpecifier = rewrittenSpecifiers[index]
		if (occurrence === undefined || rewrittenSpecifier === undefined || rewrittenSpecifier === occurrence.specifier) continue
		rewrittenText = `${ rewrittenText.slice(0, occurrence.start) }${ rewrittenSpecifier }${ rewrittenText.slice(occurrence.end) }`
	}
	return { text: rewrittenText, specifiers: rewrittenSpecifiers }
}

export function replaceImport(filePath: string, text: string) {
	return rewriteModuleSpecifiers(filePath, text).text
}

function ensureDirectoryExists(dir: string) {
	fs.mkdirSync(dir, { recursive: true })
}

function formatBunBuildLogs(logs: readonly BuildMessage[]) {
	return logs
		.map((log) => log.message)
		.join('\n')
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
	path.join(appDirectory, 'js', 'simulationStack.js'),
	path.join(appDirectory, 'js', 'websiteAccess.js'),
	path.join(appDirectory, 'inpage', 'js', 'document_start.js'),
	path.join(appDirectory, 'inpage', 'js', 'inpage.js'),
	path.join(appDirectory, 'inpage', 'js', 'listenContentScript.js'),
	path.join(appDirectory, 'inpage', 'js', 'listenContentScriptBootstrap.js'),
	path.join(appDirectory, 'js', 'utils', 'viem.js'),
]

function getExistingRuntimeEntrypointPaths() {
	return runtimeEntrypointPaths.filter((entrypointPath) => fs.existsSync(entrypointPath))
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
		external: [...externalRuntimeModules],
	})
	if (!buildResult.success) {
		throw new Error(`Failed to bundle Chrome runtime entrypoints with Bun:\n${ formatBunBuildLogs(buildResult.logs) }`)
	}
	for (const entrypointPath of existingEntrypoints) {
		const relativeEntrypointPath = path.relative(appDirectory, entrypointPath)
		const bundledEntrypointPath = path.join(bundledOutputDirectory, relativeEntrypointPath)
		if (!fs.existsSync(bundledEntrypointPath)) {
			throw new Error(`Bundled entrypoint was not written by Bun: ${ relativeEntrypointPath.replace(/\\/g, '/') }`)
		}
		fs.copyFileSync(bundledEntrypointPath, entrypointPath)
	}
	fs.rmSync(bundledOutputDirectory, { recursive: true, force: true })
}

function getRuntimeFiles() {
	return [
		path.join(directoryOfThisFile, '..', 'app', 'js'),
		path.join(directoryOfThisFile, '..', 'app', 'inpage', 'js'),
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
		.map(({ filePath, specifier }) => `${ path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/') }: ${ specifier }`)
		.join('\n')
}

function formatMissingRuntimeImportIssues(missingRuntimeImportIssues: readonly MissingRuntimeImportIssue[]) {
	return missingRuntimeImportIssues
		.map(({ filePath, specifier }) => `${ path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/') }: ${ specifier }`)
		.join('\n')
}

function traverseRuntimeDependencyGraph(processImports: RuntimeImportProcessor) {
	const visited = new Set<string>()
	const missingRuntimeImportIssues = new Map<string, MissingRuntimeImportIssue>()
	const bareImportIssues: BareImportIssue[] = []
	const forbiddenRuntimeModuleIssues: ForbiddenRuntimeModuleIssue[] = []
	const runtimeEntryFiles = getExistingRuntimeEntrypointPaths()
	const pendingFiles = [...runtimeEntryFiles]
	while (pendingFiles.length > 0) {
		const filePath = pendingFiles.pop()
		if (filePath === undefined || visited.has(filePath)) continue
		visited.add(filePath)
		const text = fs.readFileSync(filePath, 'utf8')
		const occurrences = getModuleSpecifierOccurrences(text)
		for (const rewrittenSpecifier of processImports(filePath, text, occurrences)) {
			if (isBareSpecifier(rewrittenSpecifier)) {
				bareImportIssues.push({ filePath, specifier: rewrittenSpecifier })
				continue
			}
			if (!rewrittenSpecifier.startsWith('.') && !rewrittenSpecifier.startsWith('/')) continue
			const importedFilePath = resolveRuntimeImportedFilePath(filePath, rewrittenSpecifier)
			if (importedFilePath === undefined) {
				const issueKey = `${ filePath }\0${ rewrittenSpecifier }`
				if (!missingRuntimeImportIssues.has(issueKey)) {
					missingRuntimeImportIssues.set(issueKey, { filePath, specifier: rewrittenSpecifier })
				}
				continue
			}
			pendingFiles.push(importedFilePath)
		}
		if (isBrowserIncompatibleRuntimeModule(filePath)) forbiddenRuntimeModuleIssues.push({ filePath })
	}
	return {
		files: [...visited],
		missingRuntimeImportIssues: [...missingRuntimeImportIssues.values()],
		bareImportIssues,
		forbiddenRuntimeModuleIssues,
	}
}

function collectRuntimeDependencyGraph() {
	return traverseRuntimeDependencyGraph((_filePath, _text, occurrences) => occurrences.map((occurrence) => occurrence.specifier))
}

function rewriteRuntimeImportsAndCollectDependencyGraph() {
	return traverseRuntimeDependencyGraph((filePath, text, occurrences) => {
		const rewrittenImports = rewriteModuleSpecifiers(filePath, text, occurrences)
		const runtimeText = stripSourceMappingUrlComment(rewrittenImports.text)
		if (runtimeText !== text) fs.writeFileSync(filePath, runtimeText)
		return rewrittenImports.specifiers
	})
}

export function findBareImportsInRuntimeFiles() {
	return collectRuntimeDependencyGraph().bareImportIssues
}

export function findMissingRuntimeImportsInRuntimeFiles() {
	return collectRuntimeDependencyGraph().missingRuntimeImportIssues
}

export function isBrowserIncompatibleRuntimeModule(filePath: string) {
	return forbiddenRuntimeModules.has(filePath)
}

function formatForbiddenRuntimeModuleIssues(forbiddenRuntimeModuleIssues: readonly ForbiddenRuntimeModuleIssue[]) {
	return forbiddenRuntimeModuleIssues
		.map(({ filePath }) => `${ path.relative(path.join(directoryOfThisFile, '..'), filePath).replace(/\\/g, '/') }: do not import the viem barrel entrypoint in MV3 runtime code`)
		.join('\n')
}

export function findForbiddenRuntimeModulesInRuntimeFiles() {
	return collectRuntimeDependencyGraph().forbiddenRuntimeModuleIssues
}

export function shouldKeepRuntimeOutputFile(filePath: string, reachableRuntimeFiles: ReadonlySet<string>) {
	return reachableRuntimeFiles.has(filePath)
		|| requiredRuntimeAssetPaths.has(filePath)
		|| isInsideDirectory(filePath, addressMetadataImagesDirectory)
}

export function findMissingRequiredImportedRuntimeAssets(reachableRuntimeFiles: ReadonlySet<string>) {
	return [...requiredImportedRuntimeAssetPaths]
		.filter((requiredAssetPath) => !reachableRuntimeFiles.has(requiredAssetPath))
}

function pruneRuntimeOutputFiles(reachableRuntimeFiles: ReadonlySet<string>) {
	const directoriesToKeep = new Set<string>()
	for (const keptPath of [...reachableRuntimeFiles, ...requiredRuntimeAssetPaths, addressMetadataImagesDirectory]) {
		let currentDirectoryPath = path.dirname(keptPath)
		while (isInsideDirectory(currentDirectoryPath, appDirectory)) {
			directoriesToKeep.add(currentDirectoryPath)
			if (currentDirectoryPath === appDirectory) break
			currentDirectoryPath = path.dirname(currentDirectoryPath)
		}
	}
	const pruneDirectory = (directoryPath: string) => {
		for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
			const entryPath = path.join(directoryPath, entry.name)
			if (entry.isDirectory()) {
				if (entryPath === addressMetadataImagesDirectory) continue
				if (!directoriesToKeep.has(entryPath)) {
					fs.rmSync(entryPath, { recursive: true, force: true })
					continue
				}
				pruneDirectory(entryPath)
				continue
			}
			if (!shouldKeepRuntimeOutputFile(entryPath, reachableRuntimeFiles)) fs.rmSync(entryPath, { force: true })
		}
	}
	for (const folder of getRuntimeFiles()) {
		if (!fs.existsSync(folder)) continue
		pruneDirectory(folder)
	}
}

export function stripSourceMappingUrlComment(text: string) {
	return text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=.*(?:\r?\n)?$/u, '\n')
}

export async function replaceImportsInJSFiles() {
	await bundleChromeRuntimeEntrypoints()
	for (const folder of getRuntimeFiles()) ensureDirectoryExists(folder)
	const runtimeDependencyGraph = rewriteRuntimeImportsAndCollectDependencyGraph()
	const missingRuntimeImportIssues = runtimeDependencyGraph.missingRuntimeImportIssues
	const bareImportIssues = runtimeDependencyGraph.bareImportIssues
	const forbiddenRuntimeModuleIssues = runtimeDependencyGraph.forbiddenRuntimeModuleIssues
	const reachableRuntimeFiles = new Set(runtimeDependencyGraph.files)
	const missingRequiredImportedRuntimeAssets = findMissingRequiredImportedRuntimeAssets(reachableRuntimeFiles)
	if (missingRuntimeImportIssues.length > 0) {
		throw new Error(`Runtime modules import missing files after bundling:\n${ formatMissingRuntimeImportIssues(missingRuntimeImportIssues) }`)
	}
	if (bareImportIssues.length > 0) {
		throw new Error(`Unresolved bare module specifiers remain after bundling:\n${ formatBareImportIssues(bareImportIssues) }`)
	}
	if (forbiddenRuntimeModuleIssues.length > 0) {
		throw new Error(`Browser-incompatible runtime modules remain after bundling:\n${ formatForbiddenRuntimeModuleIssues(forbiddenRuntimeModuleIssues) }`)
	}
	if (missingRequiredImportedRuntimeAssets.length > 0) {
		throw new Error(`Required runtime assets were bundled inline or left unreachable after bundling:\n${ missingRequiredImportedRuntimeAssets.join('\n') }\nEnsure vendored runtime-only modules remain listed in Bun.build external.`)
	}
	pruneRuntimeOutputFiles(reachableRuntimeFiles)
}

if (import.meta.main) {
	try {
		await replaceImportsInJSFiles()
	} catch (error) {
		console.error(error)
		process.exit(1)
	}
}
