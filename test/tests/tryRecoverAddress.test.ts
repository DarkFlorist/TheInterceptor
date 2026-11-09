import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { initSig } from 'micro-eth-signer/utils.js'
import ts from 'typescript'
import { collectFilePaths, scriptKindForPath } from '../../scripts/typescript-lint-utils.mts'
import { RecoverableMessageSignature } from '../../app/ts/types/JsonRpc-types.js'
import { bytes32String } from '../../app/ts/utils/bigint.js'
import { bytesToHex, hashMessage, privateKeyToAccount, recoverAddress } from '../../app/ts/utils/ethereumPrimitives.js'
import { tryRecoverAddress } from '../../app/ts/utils/ethereumRecovery.js'

const CURVE_ORDER = secp256k1.Point.Fn.ORDER

const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
const messageHash = hashMessage('hello')

const signHello = async () => RecoverableMessageSignature.parse(await account.signMessage({ message: 'hello' }))

// With s = 1 and R = hashScalar * G, recovery computes r^-1 * (s * R - hashScalar * G), which is the point at infinity.
const getSignatureRecoveringToInfinity = (hashScalar: bigint, flipParity = false) => {
	const compressedR = secp256k1.Point.BASE.multiply(hashScalar).toBytes(true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < CURVE_ORDER)
	const yParity = compressedR[0] === 3 ? 1 : 0
	return { r, s: 1n, yParity: flipParity ? 1 - yParity : yParity }
}

type AppSource = { readonly path: string, readonly text: string }

// Every module specifier a source loads at runtime: static imports, export-from, import-equals requires, and dynamic import() calls with a string or no-substitution template argument.
const getImportedModuleSpecifiers = ({ path, text }: AppSource) => {
	const specifiers: string[] = []
	const visit = (node: ts.Node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
		if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) specifiers.push(node.expression.text)
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text)
		ts.forEachChild(node, visit)
	}
	visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindForPath(path)))
	return specifiers
}

const getSourcesImporting = (sources: readonly AppSource[], isImportedModule: (specifier: string) => boolean) => sources.filter((source) => getImportedModuleSpecifiers(source).some(isImportedModule)).map((source) => source.path)

const isCurvesModule = (specifier: string) => specifier === '@noble/curves' || specifier.startsWith('@noble/curves/')
const isEthereumRecoveryModule = (specifier: string) => specifier.endsWith('/ethereumRecovery.js')

// Both extension source roots: the extension's own code and the injected inpage provider.
const APP_SOURCE_PATTERNS = ['app/ts/**/*.{ts,tsx}', 'app/inpage/ts/**/*.ts']
const readAppSources = async () => await Promise.all((await collectFilePaths(APP_SOURCE_PATTERNS)).map(async (path) => ({ path, text: await Bun.file(path).text() })))

// tryRecoverAddress checks a signature on the direct @noble/curves and recovers it through micro-eth-signer's, so the two must be one copy of the library.
describe('@noble/curves version coupling with micro-eth-signer', () => {
	test('the direct @noble/curves and micro-eth-signer resolve to one copy of the library', () => {
		assert.ok(initSig({ r: 1n, s: 1n }, 0) instanceof secp256k1.Signature, 'Two @noble/curves copies are installed: align package.json with the version micro-eth-signer depends on and reinstall.')
	})
})

describe('ethereumRecovery import boundaries', () => {
	test('the import guard reads both extension source roots', async () => {
		const paths = (await readAppSources()).map((source) => source.path)
		assert.ok(paths.includes('app/ts/utils/ethereumRecovery.ts'))
		assert.ok(paths.includes('app/inpage/ts/inpage.ts'))
	})

	test('the import guard finds every way a module can load @noble/curves, in either source root', () => {
		const curvesImports = [
			'import { secp256k1 } from \'@noble/curves/secp256k1.js\'',
			'import type { CurveFn } from \'@noble/curves/abstract/weierstrass.js\'',
			'export { secp256k1 } from \'@noble/curves/secp256k1.js\'',
			'import * as curves from \'@noble/curves\'',
			'import curves = require(\'@noble/curves\')',
			'const curves = await import(\'@noble/curves/secp256k1.js\')',
			'const curves = await import("@noble/curves/secp256k1.js")',
			'const curves = await import(`@noble/curves/secp256k1.js`)',
		]
		for (const root of ['app/ts', 'app/inpage/ts']) {
			for (const text of curvesImports) {
				const fixture = { path: `${ root }/fixture.ts`, text }
				assert.deepEqual(getSourcesImporting([fixture], isCurvesModule), [fixture.path], text)
			}
		}
		const unrelated = { path: 'app/ts/fixture.ts', text: '// @noble/curves\nimport { keccak_256 } from \'@noble/hashes/sha3\'\nconst name = \'@noble/curves\'' }
		assert.deepEqual(getSourcesImporting([unrelated], isCurvesModule), [])
	})

	test('only ethereumRecovery.ts imports @noble/curves in either extension source root', async () => {
		assert.deepEqual(getSourcesImporting(await readAppSources(), isCurvesModule), ['app/ts/utils/ethereumRecovery.ts'])
	})

	test('only the personal_ecRecover handler imports ethereumRecovery, so the ethereumPrimitives barrel does not ship it to every page', async () => {
		assert.deepEqual(getSourcesImporting(await readAppSources(), isEthereumRecoveryModule), ['app/ts/background/personalEcRecoverRpc.ts'])
	})
})

describe('tryRecoverAddress', () => {
	test('recovers the signer of a valid signature', async () => {
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature: await signHello() }), { type: 'recovered', address: account.address })
	})

	test('recovers the same signer from the high-s form of a valid signature', async () => {
		const { r, s, yParity } = await signHello()
		const highS = CURVE_ORDER - s
		assert.ok(highS > CURVE_ORDER / 2n)
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature: { r, s: highS, yParity: 1 - yParity } }), { type: 'recovered', address: account.address })
	})

	// Each case covers one unrecoverable input.
	test('reports signatures that recover to no address as unrecoverable', async () => {
		const { r: validR, s: validS } = await signHello()
		const unrecoverableSignatures = {
			'r is zero': { r: 0n, s: validS, yParity: 0 },
			's is zero': { r: validR, s: 0n, yParity: 0 },
			'r is the curve order': { r: CURVE_ORDER, s: validS, yParity: 0 },
			's is the curve order': { r: validR, s: CURVE_ORDER, yParity: 0 },
			'r is not a curve x-coordinate': { r: 5n, s: validS, yParity: 0 },
			'recovery lands on the point at infinity': getSignatureRecoveringToInfinity(BigInt(messageHash) % CURVE_ORDER),
		}
		for (const [name, signature] of Object.entries(unrecoverableSignatures)) {
			assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('classifies the point at infinity the way the library computes the digest scalar', async () => {
		const digestsRecoveringToScalarOne = {
			'digest shorter than 32 bytes': '0x01',
			'digest above the curve order': bytes32String(CURVE_ORDER + 1n),
			'digest longer than 32 bytes': `${ bytes32String(1n) }ff`,
		} as const
		const signature = getSignatureRecoveringToInfinity(1n)
		for (const [name, hash] of Object.entries(digestsRecoveringToScalarOne)) {
			await assert.rejects(recoverAddress({ hash, signature }), undefined, name)
			assert.deepEqual(await tryRecoverAddress({ hash, signature }), { type: 'unrecoverable' }, name)
		}
	})

	test('recovers the opposite-parity nonce point of a signature that lands on the point at infinity', async () => {
		const signature = getSignatureRecoveringToInfinity(BigInt(messageHash) % CURVE_ORDER, true)
		assert.deepEqual(await tryRecoverAddress({ hash: messageHash, signature }), { type: 'recovered', address: await recoverAddress({ hash: messageHash, signature }) })
	})

	test('recovers from a digest that reduces to zero', async () => {
		const signature = await signHello()
		const hash = bytes32String(CURVE_ORDER)
		assert.deepEqual(await tryRecoverAddress({ hash, signature }), { type: 'recovered', address: await recoverAddress({ hash, signature }) })
	})

	test('rethrows failures that are not about the signature recovering', async () => {
		await assert.rejects(tryRecoverAddress({ hash: '0xzz', signature: await signHello() }), /hex must be a 0x-prefixed hex string/u)
	})

	test('rethrows library errors from recovering a well-formed signature instead of reporting it unrecoverable', async () => {
		const signature = await signHello()
		const digestOverLibraryLimit = new Uint8Array(8193)
		await assert.rejects(tryRecoverAddress({ hash: digestOverLibraryLimit, signature }), /input is too large/u)
	})

	test('rethrows the library digest rejection when the digest and signature also land on the point at infinity', async () => {
		const digestOverLibraryLimit = new Uint8Array(8193)
		digestOverLibraryLimit[31] = 1
		const signature = { r: secp256k1.Point.CURVE().Gx, s: 1n, yParity: 0 }
		await assert.rejects(tryRecoverAddress({ hash: digestOverLibraryLimit, signature }), /input is too large/u)
	})

	test('reports invalid scalars as unrecoverable before the library sees the digest', async () => {
		const digestOverLibraryLimit = new Uint8Array(8193)
		assert.deepEqual(await tryRecoverAddress({ hash: digestOverLibraryLimit, signature: { r: 0n, s: 1n, yParity: 0 } }), { type: 'unrecoverable' })
	})
})
