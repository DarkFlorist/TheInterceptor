import * as assert from 'node:assert'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { describe, test } from 'bun:test'
import ts from 'typescript'
import { flushMicrotasks, waitFor } from '../harness/async.js'
import { isObjectWithOptionalProperties, type PropertiesOf } from '../harness/assertions.js'

const inpageSourcePath = path.resolve('app/inpage/ts/inpage.ts')
// Names that live inside the provider's function scope and that a dapp might plausibly declare itself.
const INPAGE_INTERNAL_NAMES = ['isRecord', 'inpageWindow', 'injectInterceptor', 'EthereumJsonRpcError', 'createBackgroundBridge', 'createDeferred', 'parseRpcError', 'isStringArray']

type Listener = (event: unknown) => void

const isPageMessageCandidate = (value: unknown): value is PropertiesOf<'type' | 'method' | 'requestId'> => isObjectWithOptionalProperties(value)

// MV3 registers the Bun-bundled app/inpage/js/inpage.js as a MAIN world content script.
async function buildManifestV3Inpage() {
	// Without an outdir, Bun.build keeps its bundles in memory (BuildOutput.outputs) and writes nothing to disk.
	const buildResult = await Bun.build({ entrypoints: [inpageSourcePath], target: 'browser', format: 'esm', splitting: false })
	if (!buildResult.success) throw new Error(buildResult.logs.map((log) => log.message).join('\n'))
	const output = buildResult.outputs[0]
	if (output === undefined) throw new Error('Bundling the main-world provider produced no output')
	return await output.text()
}

// MV2 inlines the tsc output for tsconfig-inpage.json into document_start.js, which injects it as an inline page script.
async function compileManifestV2Inpage() {
	const configFile = ts.readConfigFile(path.resolve('tsconfig-inpage.json'), ts.sys.readFile)
	if (configFile.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.resolve('.'))
	return ts.transpileModule(await Bun.file(inpageSourcePath).text(), { compilerOptions: options, fileName: inpageSourcePath }).outputText
}

function getTopLevelStatementsOtherThanFunctionScope(source: string) {
	const sourceFile = ts.createSourceFile('inpage.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
	const statements = sourceFile.statements.filter((statement) => !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use strict'))
	const isFunctionScopeCall = (statement: ts.Statement) => {
		if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
		let callee: ts.Expression = statement.expression.expression
		while (ts.isParenthesizedExpression(callee)) callee = callee.expression
		return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
	}
	if (statements.length === 1 && statements[0] !== undefined && isFunctionScopeCall(statements[0])) return []
	return statements.map((statement) => statement.getText(sourceFile).slice(0, 80))
}

function createFakePage() {
	const listeners = new Map<string, Set<Listener>>()
	// Every bridge port the provider registered; each provider instance registers one.
	const bridgePorts: MessagePort[] = []
	const dispatchEvent = (event: unknown) => {
		const type = isPageMessageCandidate(event) && typeof event.type === 'string' ? event.type : undefined
		if (type === undefined) return true
		for (const listener of listeners.get(type) ?? []) listener(event)
		return true
	}
	const pageGlobal = {
		console,
		setTimeout,
		clearTimeout,
		Event,
		CustomEvent,
		MessageChannel,
		location: { origin: 'https://dapp.example' },
		addEventListener: (type: string, listener: Listener) => {
			const existing = listeners.get(type)
			if (existing === undefined) listeners.set(type, new Set([listener]))
			else existing.add(listener)
		},
		removeEventListener: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener) },
		dispatchEvent,
		postMessage: (data: unknown, _targetOrigin: string, transfer?: readonly unknown[]) => {
			if (!isPageMessageCandidate(data) || data.type !== 'interceptor_bridge_port') return
			const port = transfer?.find((item): item is MessagePort => item instanceof MessagePort)
			if (port === undefined) throw new Error('missing bridge port')
			bridgePorts.push(port)
			// Answer the signer handshake with compatibility mode enabled so the intended window.web3 global is installed too.
			port.onmessage = (event: MessageEvent<unknown>) => {
				const request = event.data
				if (!isPageMessageCandidate(request) || request.method !== 'connected_to_signer' || typeof request.requestId !== 'number') return
				port.postMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: 'connected_to_signer', result: { metamaskCompatibilityMode: true } })
			}
		},
	}
	const context = vm.createContext(pageGlobal)
	vm.runInContext('globalThis.window = globalThis', context)
	return {
		context,
		bridgePorts,
		countPageListeners: () => [...listeners.values()].reduce((count, typeListeners) => count + typeListeners.size, 0),
		closeBridgePorts: () => { for (const port of bridgePorts) port.close() },
	}
}

async function waitForPageCondition(context: vm.Context, condition: string) {
	await waitFor(() => vm.runInContext(condition, context) === true, { timeoutMs: 2000, description: condition })
}

const getGlobalOwnKeys = (context: vm.Context): string[] => vm.runInContext('[...Object.getOwnPropertyNames(globalThis), ...Object.getOwnPropertySymbols(globalThis).map(String)]', context)

const PROVIDER_READY_CONDITION = 'globalThis.ethereum?.isInterceptor === true && globalThis.ethereum.isMetaMask === true && globalThis.web3 !== undefined'
// The run-once marker inpage.ts leaves on window; it is the only symbol-keyed global the provider adds.
const INPAGE_SCRIPT_RAN_MARKER_SOURCE = 'Symbol.for(\'TheInterceptor.inpageScriptRan\')'

describe('inpage global scope', () => {
	for (const { name, build } of [{ name: 'manifest v3 bundle', build: buildManifestV3Inpage }, { name: 'manifest v2 inline script', build: compileManifestV2Inpage }]) {
		test(`${ name } keeps all runtime bindings inside one function scope`, async () => {
			assert.deepEqual(getTopLevelStatementsOtherThanFunctionScope(await build()), [])
		})

		test(`${ name } adds only the provider globals to the page and leaves dapp declarations free`, async () => {
			const source = await build()
			const { context, closeBridgePorts } = createFakePage()
			try {
				const globalKeysBeforeLoad = getGlobalOwnKeys(context)
				vm.runInContext(source, context)
				await waitForPageCondition(context, PROVIDER_READY_CONDITION)

				const addedGlobalKeys = getGlobalOwnKeys(context).filter((key) => !globalKeysBeforeLoad.includes(key))
				assert.deepEqual(addedGlobalKeys.sort(), ['Symbol(TheInterceptor.inpageScriptRan)', 'ethereum', 'web3'])
				assert.equal(vm.runInContext(`Object.getOwnPropertyDescriptor(globalThis, ${ INPAGE_SCRIPT_RAN_MARKER_SOURCE }).enumerable`, context), false)
				assert.equal(vm.runInContext(`Object.getOwnPropertyDescriptor(globalThis, ${ INPAGE_SCRIPT_RAN_MARKER_SOURCE }).configurable`, context), true)
				// A later dapp classic script must be able to declare names the provider uses internally.
				assert.doesNotThrow(() => vm.runInContext(INPAGE_INTERNAL_NAMES.map((internalName, index) => index % 2 === 0 ? `const ${ internalName } = ${ index }` : `class ${ internalName } {}`).join('\n'), context))
			} finally {
				closeBridgePorts()
			}
		})

		test(`${ name } installs a single provider when it runs twice in the same page`, async () => {
			const source = await build()
			const { context, bridgePorts, countPageListeners, closeBridgePorts } = createFakePage()
			try {
				vm.runInContext(source, context)
				await waitForPageCondition(context, PROVIDER_READY_CONDITION)
				const providerFromFirstRun: unknown = vm.runInContext('globalThis.ethereum', context)
				const pageListenersFromFirstRun = countPageListeners()

				// MV2 can inject the script again into a page that outlived an extension reload.
				vm.runInContext(source, context)
				await flushMicrotasks()

				assert.equal(bridgePorts.length, 1)
				assert.equal(vm.runInContext('globalThis.ethereum', context), providerFromFirstRun)
				assert.equal(countPageListeners(), pageListenersFromFirstRun)
			} finally {
				closeBridgePorts()
			}
		})
	}
})
