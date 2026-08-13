import * as assert from 'node:assert'
import { test } from 'bun:test'

const backgroundSource = await Bun.file(new URL('../../app/ts/background/background.ts', import.meta.url)).text()
const confirmTransactionSource = await Bun.file(new URL('../../app/ts/background/windows/confirmTransaction.ts', import.meta.url)).text()
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const confirmTransactionComponentSource = await Bun.file(new URL('../../app/ts/components/pages/ConfirmTransaction.tsx', import.meta.url)).text()
const safeSourceDirectory = new URL('../../app/ts/safe/', import.meta.url).pathname
const safeSourceFiles: string[] = []
for await (const file of new Bun.Glob('*.ts').scan({ cwd: safeSourceDirectory, absolute: true })) safeSourceFiles.push(file)
const safeSources = await Promise.all(safeSourceFiles.map(async (file) => await Bun.file(file).text()))

test('the general RPC dispatcher delegates Gnosis Safe policy as one decision', () => {
	assert.match(backgroundSource, /import \{ getSafeModeRpcPolicyReply \} from '\.\.\/safe\/safeRequestPolicy\.js'/u)
	assert.doesNotMatch(backgroundSource, /SAFE_MESSAGE_SIGNING_METHODS|isSafeTransactionCoSignRequest|safeModeUnsupportedMethod/u)
	assert.doesNotMatch(backgroundSource, /Gnosis Safe message signing is not supported|Gnosis Safe transaction proposals require/u)
})

test('the confirmation window delegates Gnosis Safe resolution, persistence, and preparation', () => {
	assert.match(confirmTransactionSource, /resolveSafeConfirmation\(/u)
	assert.match(confirmTransactionSource, /resolveSafeSignerReply\(/u)
	assert.match(confirmTransactionSource, /prepareSafeTransactionConfirmation\(/u)
	assert.match(confirmTransactionSource, /safePreparation\.finalize\(/u)
	assert.doesNotMatch(confirmTransactionSource, /from '\.\.\/\.\.\/safe\/(?:safeCore|safeStack|safeSimulation)\.js'/u)
	assert.doesNotMatch(confirmTransactionSource, /persistSignedSafeTransaction|validateSafeOwnerSignature|reconcileSafeTransactionState/u)
	assert.doesNotMatch(confirmTransactionSource, /safeExecutionSignerRoute|reconciledStoredSafeState/u)
})

test('popup message handlers delegate Gnosis Safe stack import and export', () => {
	assert.match(popupMessageHandlersSource, /export \{ importSafeStack, requestSafeStackExport, validateSafeTransactionStackForCurrentContract \} from '\.\/safeStackHandlers\.js'/u)
	assert.doesNotMatch(popupMessageHandlersSource, /function validateSafeTransactionStackForCurrentContract/u)
})

test('the Gnosis Safe domain layer does not import background orchestration', () => {
	for (const safeSource of safeSources) assert.doesNotMatch(safeSource, /from '\.\.\/background\//u)
})

test('the confirmation presentation imports shared Safe flow policy from the domain layer', () => {
	assert.match(confirmTransactionComponentSource, /from '\.\.\/\.\.\/safe\/safePendingFlow\.js'/u)
	assert.doesNotMatch(confirmTransactionComponentSource, /from '\.\.\/\.\.\/background\/safePendingFlow\.js'/u)
})
