import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import * as funtypes from 'funtypes'
import { initSig } from 'micro-eth-signer/utils.js'
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

const PackageDependencies = funtypes.ReadonlyObject({ dependencies: funtypes.ReadonlyRecord(funtypes.String, funtypes.String) })
const getCurvesDependencyVersion = async (packageJsonPath: string) => PackageDependencies.parse(await Bun.file(new URL(packageJsonPath, import.meta.url)).json()).dependencies['@noble/curves']

const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const getAppSourcesMatching = async (importPattern: RegExp) => {
	const matchingSources: string[] = []
	for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory })) {
		if (importPattern.test(await Bun.file(`${ appSourceDirectory }${ file }`).text())) matchingSources.push(file)
	}
	return matchingSources
}

// tryRecoverAddress checks a signature on the direct @noble/curves and recovers it through micro-eth-signer's, so the two must be one copy of the library.
describe('@noble/curves version coupling with micro-eth-signer', () => {
	test('package.json pins @noble/curves to the exact version micro-eth-signer depends on, so upgrading micro-eth-signer must bump both', async () => {
		const requiredVersion = await getCurvesDependencyVersion('../../node_modules/micro-eth-signer/package.json')
		assert.equal(await getCurvesDependencyVersion('../../package.json'), requiredVersion, `micro-eth-signer depends on @noble/curves ${ requiredVersion }: set the same exact version in package.json so tryRecoverAddress and recoverAddress stay on one copy of the library.`)
	})

	test('the direct @noble/curves and micro-eth-signer resolve to one copy of the library', () => {
		assert.ok(initSig({ r: 1n, s: 1n }, 0) instanceof secp256k1.Signature, 'Two @noble/curves copies are installed: align package.json with the version micro-eth-signer depends on and reinstall.')
	})
})

describe('ethereumRecovery import boundaries', () => {
	test('only ethereumRecovery.ts imports @noble/curves in app code', async () => {
		assert.deepEqual(await getAppSourcesMatching(/from '@noble\/curves/u), ['utils/ethereumRecovery.ts'])
	})

	test('only the personal_ecRecover handler imports ethereumRecovery, so the ethereumPrimitives barrel does not ship it to every page', async () => {
		assert.deepEqual(await getAppSourcesMatching(/from '[^']*ethereumRecovery\.js'/u), ['background/personalEcRecoverRpc.ts'])
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
