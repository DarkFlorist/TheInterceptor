import * as assert from 'node:assert'
import { test } from 'bun:test'
import ts from 'typescript'

// RPC URLs can embed credentials, so app code reads them raw only to compare them, to hand them to the functions in app/ts/utils/rpcUrlCredentials.ts that own credentials, or at one of the reviewed uses below. A new raw read must either go through redactRpcUrlCredentials or be added here with the reason it is never displayed or logged.
const RAW_RPC_URL_PROPERTIES = new Set(['httpsRpc', 'rpcUrl'])
const CREDENTIAL_OWNING_FUNCTIONS = new Set(['redactRpcUrlCredentials', 'removeRpcUrlCredentials', 'getRpcFetchTarget', 'getRpcUrlCredentialsTransportError'])
const EQUALITY_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

const REVIEWED_RAW_RPC_URL_READS: readonly { file: string, line: string, reason: string }[] = [
	{ file: 'app/ts/background/popupSimulationFingerprint.ts', line: 'httpsRpc: rpcNetwork.httpsRpc,', reason: 'Hashed into the popup fingerprint, never shown.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', line: 'const rpcUrl = rpcConnectionStatus.rpcNetwork.httpsRpc', reason: 'Matches slow requests to the active endpoint.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', line: 'const slowRequest = getCurrentSlowRpcRequest(config.slowRpcRequests, rpcEntry.httpsRpc)', reason: 'Matches slow requests to the active endpoint.' },
	{ file: 'app/ts/background/rpcSlowRequestTracking.ts', line: 'export const slowRpcRequestKey = (request: SlowRpcRequest) => `${ request.rpcUrl }-${ request.requestId }-${ request.startedAt.toISOString() }`', reason: 'In-memory map key, never shown.' },
	{ file: 'app/ts/components/subcomponents/ConfigureRpcConnection.tsx', line: 'const parsedData = parseRpcFormData(new FormData(form), defaultValues?.httpsRpc)', reason: 'Saving an edited entry keeps its stored URL; the form only shows it redacted.' },
	{ file: 'app/ts/simulation/serviceLifecycle.ts', line: 'new EthereumJSONRpcRequestHandler(rpcNetwork.httpsRpc, true, rpcRequestLifecycleCallbacks),', reason: 'The request handler sends through getRpcFetchTarget.' },
	{ file: 'app/ts/simulation/services/EthereumJSONRpcRequestHandler.ts', line: 'rpcUrl: this.rpcUrl,', reason: 'Identifies the endpoint of a slow request; background-startup redacts it before reporting.' },
]

type RawRpcUrlRead = { file: string, line: string }

function isAssignmentTarget(node: ts.Node) {
	return ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.parent.left === node
}

function isEqualityOperand(node: ts.Node) {
	return ts.isBinaryExpression(node.parent) && EQUALITY_OPERATORS.has(node.parent.operatorToken.kind)
}

function isCredentialOwningFunctionArgument(node: ts.Expression) {
	const call = node.parent
	return ts.isCallExpression(call) && call.arguments.includes(node) && ts.isIdentifier(call.expression) && CREDENTIAL_OWNING_FUNCTIONS.has(call.expression.text)
}

function getRawRpcUrlPropertyName(node: ts.Node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
	// Destructuring such as `const { httpsRpc } = entry` reads the raw value too.
	if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
		const propertyName = node.propertyName ?? node.name
		return ts.isIdentifier(propertyName) ? propertyName.text : undefined
	}
	return undefined
}

function collectUncheckedRawRpcUrlReads(file: string, sourceText: string) {
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const reads: RawRpcUrlRead[] = []
	const visit = (node: ts.Node) => {
		const propertyName = getRawRpcUrlPropertyName(node)
		if (propertyName !== undefined && RAW_RPC_URL_PROPERTIES.has(propertyName)) {
			const isCheckedUse = ts.isExpression(node) && (isAssignmentTarget(node) || isEqualityOperand(node) || isCredentialOwningFunctionArgument(node))
			if (!isCheckedUse) reads.push({ file, line: sourceText.split('\n')[sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line]?.trim() ?? '' })
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return reads
}

async function collectAppRawRpcUrlReads() {
	const appDirectory = new URL('../../', import.meta.url).pathname
	const reads: RawRpcUrlRead[] = []
	for await (const file of new Bun.Glob('app/ts/**/*.{ts,tsx}').scan({ cwd: appDirectory })) {
		reads.push(...collectUncheckedRawRpcUrlReads(file, await Bun.file(`${ appDirectory }${ file }`).text()))
	}
	return reads.sort((left, right) => `${ left.file }:${ left.line }`.localeCompare(`${ right.file }:${ right.line }`))
}

test('app code reads raw RPC URLs only to compare them, through the credential-owning functions, or at reviewed uses', async () => {
	const reviewedReads = REVIEWED_RAW_RPC_URL_READS.map(({ file, line }) => ({ file, line }))
	assert.deepEqual(await collectAppRawRpcUrlReads(), reviewedReads)
})

test('the raw RPC URL scan flags display and logging uses', () => {
	const source = [
		'const label = `${ entry.name } (${ entry.httpsRpc })`',
		'console.error(request.rpcUrl)',
		'const { httpsRpc } = entry',
		'const selected = entry.httpsRpc === other.httpsRpc',
		'const displayed = redactRpcUrlCredentials(entry.httpsRpc)',
	].join('\n')
	assert.deepEqual(collectUncheckedRawRpcUrlReads('example.ts', source).map((read) => read.line), [
		'const label = `${ entry.name } (${ entry.httpsRpc })`',
		'console.error(request.rpcUrl)',
		'const { httpsRpc } = entry',
	])
})
