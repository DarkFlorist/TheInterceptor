import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { AddressBookEntry, getSafeSignerAddresses } from '../../app/ts/types/addressBookTypes.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { SafeStackExport } from '../../app/ts/types/safeTypes.js'
import { SAFE_ABI, assertInterceptorSafeTransactionPolicy, assertSafeEoaOwner, assertSafeOwner, createSafeTx, getSafeContractState, getSortedSafeSignatureBytes, normalizeSafeSignature, recoverSafeSignatureOwner, safeTxToTypedDataJson } from '../../app/ts/safe/safeCore.js'
import { completeSafeExecutionWithConfiguredSigner, SAFE_EXECUTION_ABI } from '../../app/ts/safe/safeExecution.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { decodeFunctionDataStrict, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'

const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('Safe transaction support', () => {
	test('creates a canonical Safe transaction that round-trips through EIP-712 JSON', () => {
		const safeTx = createSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 42n,
			input: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
		}, 7n)
		const json = safeTxToTypedDataJson(safeTx)
		const parsedJson = JSON.parse(json)

		assert.equal(parsedJson.domain.chainId, '1')
		assert.equal(parsedJson.message.nonce, '7')
		assert.equal(parsedJson.message.data, '0xdeadbeef')
		assert.doesNotThrow(() => EIP712Message.parse(json))
		assert.equal(BigInt(getSafeTxHash(safeTx)), BigInt(getSafeTxHash(SafeTx.parse(parsedJson))))
	})

	test('allows only CALL transactions without gas reimbursement fields', () => {
		const safeTx = createSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 0n)

		assert.doesNotThrow(() => assertInterceptorSafeTransactionPolicy(safeTx))
		assert.throws(() => assertInterceptorSafeTransactionPolicy({
			...safeTx,
			message: { ...safeTx.message, operation: 1n },
		}), /CALL operations only/u)
		assert.throws(() => assertInterceptorSafeTransactionPolicy({
			...safeTx,
			message: { ...safeTx.message, safeTxGas: 1n },
		}), /zero gas reimbursement fields/u)
	})

	test('normalizes and recovers an EOA Safe owner signature', async () => {
		const account = privateKeyToAccount(privateKey)
		const safeTx = createSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 0n)
		const signature = await account.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
		const recoveryByteZeroOrOne = `${ signature.slice(0, -2) }${ Number.parseInt(signature.slice(-2), 16) - 27 === 0 ? '00' : '01' }`

		assert.equal(normalizeSafeSignature(recoveryByteZeroOrOne), signature)
		assert.equal(await recoverSafeSignatureOwner(BigInt(getSafeTxHash(safeTx)), signature), BigInt(account.address))
	})

	test('sorts Safe signature bytes by owner address', () => {
		const firstSignature = `0x${ '11'.repeat(64) }1b`
		const secondSignature = `0x${ '22'.repeat(64) }1c`

		assert.equal(
			getSortedSafeSignatureBytes([
				{ signer: 2n, signature: secondSignature },
				{ signer: 1n, signature: firstSignature },
			]),
			`0x${ firstSignature.slice(2) }${ secondSignature.slice(2) }`,
		)
	})

	test('completes a final Safe execution approval with the configured sender instead of another signature request', async () => {
		const account = privateKeyToAccount(privateKey)
		const safeAddress = 0x1234n
		const configuredSigner = 1n
		const safeTx = createSafeTx(1n, safeAddress, {
			to: 0x5678n,
			value: 42n,
			input: new Uint8Array([0xde, 0xad]),
		}, 7n)
		const signature = await account.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
		const input = bytesFromHex(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
			'0x0000000000000000000000000000000000005678',
			42n,
			'0xdead',
			0n,
			0n,
			0n,
			0n,
			'0x0000000000000000000000000000000000000000',
			'0x0000000000000000000000000000000000000000',
			signature,
		]))

		const completed = await completeSafeExecutionWithConfiguredSigner(1n, safeAddress, configuredSigner, {
			version: '1.4.1',
			nonce: 7n,
			owners: [configuredSigner, BigInt(account.address)],
			threshold: 2n,
		}, input)
		const decoded = decodeFunctionDataStrict(SAFE_EXECUTION_ABI, bytesToHex(completed))
		const completedSignatures = decoded.args[9]
		const prevalidatedSignature = `${ configuredSigner.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`

		assert.equal(completedSignatures, `0x${ prevalidatedSignature }${ signature.slice(2) }`)
	})

	test('serializes a shareable Safe stack and parses it back', () => {
		const safeTx = createSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 3n)
		const safeTxHash = BigInt(getSafeTxHash(safeTx))
		const stack = {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [{
				chainId: 1n,
				safeAddress: 0x1234n,
				safeVersion: '1.4.1',
				baseNonce: 3n,
				threshold: 2n,
				transactions: [{
					safeTx,
					safeTxHash,
					created: new Date('2026-01-01T00:00:00.000Z'),
					websiteOrigin: 'https://example.test',
					transactionIdentifier: 9n,
					signatures: [],
				}],
			}],
		} as const

		assert.deepEqual(SafeStackExport.parse(SafeStackExport.serialize(stack)), stack)
	})

	test('parses a chain-specific Safe address-book entry with an optional Safe signer', () => {
		const entry = AddressBookEntry.parse({
			type: 'safe',
			name: 'Treasury Safe',
			address: '0x0000000000000000000000000000000000001234',
			chainId: '0x1',
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress: '0x0000000000000000000000000000000000005678',
			safeSignerAddresses: [
				'0x0000000000000000000000000000000000009abc',
				'0x0000000000000000000000000000000000005678',
			],
			abi: '[]',
			safeVersion: '1.4.1',
		})

		assert.equal(entry.type, 'safe')
		assert.equal(entry.address, 0x1234n)
		assert.equal(entry.safeSignerAddress, 0x5678n)
		assert.deepEqual(getSafeSignerAddresses(entry), [0x9abcn, 0x5678n])
		assert.deepEqual(getSafeSignerAddresses({ ...entry, safeSignerAddress: 0x9abcn }), [0x9abcn, 0x5678n])
		assert.deepEqual(getSafeSignerAddresses({ ...entry, safeSignerAddress: 0xdef0n }), [0x9abcn, 0x5678n, 0xdef0n])
		assert.equal(entry.abi, '[]')
	})

	test('reads Safe metadata and rejects configured non-owners and contract owners', async () => {
		const owner = 0x5678n
		const selectors = {
			version: encodeFunctionCall(SAFE_ABI, 'VERSION', []).slice(0, 10),
			nonce: encodeFunctionCall(SAFE_ABI, 'nonce', []).slice(0, 10),
			owners: encodeFunctionCall(SAFE_ABI, 'getOwners', []).slice(0, 10),
			threshold: encodeFunctionCall(SAFE_ABI, 'getThreshold', []).slice(0, 10),
			isOwner: encodeFunctionCall(SAFE_ABI, 'isOwner', ['0x0000000000000000000000000000000000005678']).slice(0, 10),
		}
		const createEthereum = (ownerIsValid: boolean) => ({
			async getBlockNumber() {
				return 123n
			},
			async getCode(_address: bigint, blockTag: bigint | string) {
				assert.equal(blockTag, 123n)
				return new Uint8Array([1])
			},
			async call(transaction: { readonly input: Uint8Array }, blockTag: bigint | string) {
				assert.equal(blockTag, 123n)
				switch (bytesToHex(transaction.input).slice(0, 10)) {
					case selectors.version: return encodeFunctionReturn(SAFE_ABI, 'VERSION', ['1.4.1'])
					case selectors.nonce: return encodeFunctionReturn(SAFE_ABI, 'nonce', [3n])
					case selectors.owners: return encodeFunctionReturn(SAFE_ABI, 'getOwners', [['0x0000000000000000000000000000000000005678']])
					case selectors.threshold: return encodeFunctionReturn(SAFE_ABI, 'getThreshold', [2n])
					case selectors.isOwner: return encodeFunctionReturn(SAFE_ABI, 'isOwner', [ownerIsValid])
					default: throw new Error('Unexpected Safe call')
				}
			},
		})

		assert.deepEqual(await getSafeContractState(createEthereum(true), 0x1234n), {
			version: '1.4.1',
			nonce: 3n,
			owners: [owner],
			threshold: 2n,
		})
		await assert.doesNotReject(assertSafeOwner(createEthereum(true), 0x1234n, owner))
		await assert.rejects(assertSafeOwner(createEthereum(false), 0x1234n, owner), /is not an owner of Gnosis Safe/u)
		await assert.doesNotReject(assertSafeEoaOwner({
			...createEthereum(true),
			async getCode() { return new Uint8Array() },
		}, 0x1234n, owner))
		await assert.rejects(assertSafeEoaOwner(createEthereum(true), 0x1234n, owner), /supports EOA owners only/u)
	})
})
