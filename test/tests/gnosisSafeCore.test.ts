import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { AddressBookEntry, getGnosisSafeSignerAddresses } from '../../app/ts/types/addressBookTypes.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { GnosisSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { GnosisSafeStackExport } from '../../app/ts/types/gnosisSafeTypes.js'
import { GNOSIS_SAFE_ABI, assertInterceptorGnosisSafeTransactionPolicy, assertGnosisSafeDomainChainIsConnectedChain, createGnosisSafeOwnerValidator, createGnosisSafeTx, getGnosisSafeContractSnapshot, getGnosisSafeContractState, getGnosisSafeTxSignerFacingTypedData, getGnosisSafeTxSigningHashes, isGnosisSafeContractValidationFailure, isGnosisSafeOwnerValidationFailure, normalizeGnosisSafeSignature, recoverGnosisSafeSignatureOwner, gnosisSafeTxToTypedDataJson, validateGnosisSafeOwnerIsEoa, validateGnosisSafeTransactionForSigning } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { completeGnosisSafeExecutionWithConfiguredSigner, GNOSIS_SAFE_EXECUTION_ABI } from '../../app/ts/gnosisSafe/gnosisSafeExecution.js'
import { getMessageAndDomainHash, getGnosisSafeTxHash } from '../../app/ts/utils/eip712.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumPrimitives.js'
import { bytesFromHex, bytesToHex, concat, ensureHex, keccak256 } from '../../app/ts/utils/ethereumBytes.js'
import { decodeFunctionDataStrict, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'

const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('Gnosis Safe transaction support', () => {
	test('creates a canonical Gnosis Safe transaction that round-trips through EIP-712 JSON', () => {
		const safeTx = createGnosisSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 42n,
			input: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
		}, 7n)
		const json = gnosisSafeTxToTypedDataJson(safeTx)
		const parsedJson = JSON.parse(json)

		assert.equal(parsedJson.domain.chainId, '1')
		assert.equal(parsedJson.message.nonce, '7')
		assert.equal(parsedJson.message.data, '0xdeadbeef')
		assert.doesNotThrow(() => EIP712Message.parse(json))
		assert.equal(BigInt(getGnosisSafeTxHash(safeTx)), BigInt(getGnosisSafeTxHash(GnosisSafeTx.parse(parsedJson))))
	})

	test('derives the signer-facing EIP-712 hashes that combine into the validated Gnosis Safe transaction hash', () => {
		const safeTx = createGnosisSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 42n,
			input: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
		}, 7n)
		const { domainHash, messageHash } = getGnosisSafeTxSigningHashes(safeTx)

		// The hashes must describe the exact eth_signTypedData_v4 payload the signer wallet receives, regardless of which owner signs.
		const signerFacingTypedData = getGnosisSafeTxSignerFacingTypedData(safeTx)
		assert.deepEqual(signerFacingTypedData, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
		assert.deepEqual({ domainHash, messageHash }, getMessageAndDomainHash({ method: 'eth_signTypedData_v4', params: [0xabcdn, signerFacingTypedData] }))
		// A hardware signer derives the signed digest as keccak256(0x1901 ‖ domainHash ‖ messageHash); it must equal the contract-validated hash.
		const signedDigest = keccak256(concat(['0x1901', ensureHex(domainHash), ensureHex(messageHash)]))
		assert.equal(BigInt(signedDigest), BigInt(getGnosisSafeTxHash(safeTx)))
		assert.notEqual(getGnosisSafeTxSigningHashes(createGnosisSafeTx(1n, 0x1234n, { to: 0x5678n, value: 42n, input: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }, 8n)).messageHash, messageHash)
	})

	test('rejects arbitrary delegate calls and gas reimbursement fields', () => {
		const safeTx = createGnosisSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 0n)

		assert.doesNotThrow(() => assertInterceptorGnosisSafeTransactionPolicy(safeTx))
		assert.throws(() => assertInterceptorGnosisSafeTransactionPolicy({
			...safeTx,
			message: { ...safeTx.message, operation: 1n },
		}), (error) => isGnosisSafeContractValidationFailure(error) && /DELEGATECALL is supported only/u.test(error.message))
		assert.throws(() => assertInterceptorGnosisSafeTransactionPolicy({
			...safeTx,
			message: { ...safeTx.message, safeTxGas: 1n },
		}), (error) => isGnosisSafeContractValidationFailure(error) && /zero gas reimbursement fields/u.test(error.message))
	})

	test('accepts a GnosisSafeTx domain chain only when it is the connected chain and that chain has an ID', () => {
		const expectedFailure = (pattern: RegExp) => (error: unknown) => isGnosisSafeContractValidationFailure(error) && pattern.test(error.message)
		assert.doesNotThrow(() => assertGnosisSafeDomainChainIsConnectedChain(1n, 1n))
		assert.throws(() => assertGnosisSafeDomainChainIsConnectedChain(0n, 0n), expectedFailure(/require a chain ID/u))
		assert.throws(() => assertGnosisSafeDomainChainIsConnectedChain(undefined, 0n), expectedFailure(/require a chain ID/u))
		assert.throws(() => assertGnosisSafeDomainChainIsConnectedChain(2n, 1n), expectedFailure(/prepared for chain 2, but the connected network is chain 1\./u))
		assert.throws(() => assertGnosisSafeDomainChainIsConnectedChain(undefined, 1n), expectedFailure(/prepared for an unspecified chain, but the connected network is chain 1\./u))
	})

	test('classifies stale or mismatched Gnosis Safe transaction state as an expected validation failure', async () => {
		const safeAddress = 0x1234n
		const owner = 0x5678n
		const selectors = {
			version: encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []).slice(0, 10),
			nonce: encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []).slice(0, 10),
			owners: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []).slice(0, 10),
			threshold: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', []).slice(0, 10),
			transactionHash: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getTransactionHash', [
				'0x0000000000000000000000000000000000009abc', 0n, '0x', 0n, 0n, 0n, 0n,
				'0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 3n,
			]).slice(0, 10),
		}
		const ethereum = {
			getChainId: () => 1n,
			getBlockNumber: async () => 123n,
			getCode: async (address: bigint) => address === safeAddress ? new Uint8Array([1]) : new Uint8Array(),
			call: async (transaction: { readonly input: Uint8Array }) => {
				switch (bytesToHex(transaction.input).slice(0, 10)) {
					case selectors.version: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', ['1.4.1'])
					case selectors.nonce: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [3n])
					case selectors.owners: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [['0x0000000000000000000000000000000000005678']])
					case selectors.threshold: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [1n])
					case selectors.transactionHash: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getTransactionHash', ['0x0000000000000000000000000000000000000000000000000000000000000000'])
					default: throw new Error('Unexpected Gnosis Safe call')
				}
			},
		}
		const currentSafeTx = createGnosisSafeTx(1n, safeAddress, { to: 0x9abcn, value: 0n, input: new Uint8Array() }, 3n)
		const expectedFailure = (pattern: RegExp) => (error: unknown) => isGnosisSafeContractValidationFailure(error) && pattern.test(error.message)

		await assert.rejects(validateGnosisSafeTransactionForSigning(
			ethereum, safeAddress, owner, { ...currentSafeTx, domain: { ...currentSafeTx.domain, chainId: 2n } }, '1.4.1',
		), expectedFailure(/prepared for chain 2, but the connected network is chain 1\./u))
		await assert.rejects(validateGnosisSafeTransactionForSigning(
			ethereum, safeAddress, owner, currentSafeTx, '1.3.0',
		), expectedFailure(/address-book entry records 1\.3\.0/u))
		await assert.rejects(validateGnosisSafeTransactionForSigning(
			ethereum, safeAddress, owner, { ...currentSafeTx, message: { ...currentSafeTx.message, nonce: 2n } }, '1.4.1',
		), expectedFailure(/older than the current nonce/u))
		await assert.rejects(validateGnosisSafeTransactionForSigning(
			ethereum, safeAddress, owner, currentSafeTx, '1.4.1',
		), expectedFailure(/locally computed Gnosis Safe transaction hash/u))
	})

	test('normalizes and recovers an EOA Gnosis Safe owner signature', async () => {
		const account = privateKeyToAccount(privateKey)
		const safeTx = createGnosisSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 0n)
		const signature = await account.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
		const recoveryByteZeroOrOne = `${ signature.slice(0, -2) }${ Number.parseInt(signature.slice(-2), 16) - 27 === 0 ? '00' : '01' }`

		assert.equal(normalizeGnosisSafeSignature(recoveryByteZeroOrOne), signature)
		assert.equal(await recoverGnosisSafeSignatureOwner(BigInt(getGnosisSafeTxHash(safeTx)), signature), BigInt(account.address))
	})

	test('completes a final Gnosis Safe execution approval with the configured sender instead of another signature request', async () => {
		const account = privateKeyToAccount(privateKey)
		const safeAddress = 0x1234n
		const configuredSigner = 1n
		const safeTx = createGnosisSafeTx(1n, safeAddress, {
			to: 0x5678n,
			value: 42n,
			input: new Uint8Array([0xde, 0xad]),
		}, 7n)
		const signature = await account.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
		const input = bytesFromHex(encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
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

		const completed = await completeGnosisSafeExecutionWithConfiguredSigner(1n, safeAddress, configuredSigner, {
			version: '1.4.1',
			nonce: 7n,
			owners: [configuredSigner, BigInt(account.address)],
			threshold: 2n,
		}, input)
		const decoded = decodeFunctionDataStrict(GNOSIS_SAFE_EXECUTION_ABI, bytesToHex(completed))
		const completedSignatures = decoded.args[9]
		const prevalidatedSignature = `${ configuredSigner.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`

		assert.equal(completedSignatures, `0x${ prevalidatedSignature }${ signature.slice(2) }`)
	})

	test('serializes a shareable Gnosis Safe stack and parses it back', () => {
		const safeTx = createGnosisSafeTx(1n, 0x1234n, {
			to: 0x5678n,
			value: 0n,
			input: new Uint8Array(),
		}, 3n)
		const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
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

		assert.deepEqual(GnosisSafeStackExport.parse(GnosisSafeStackExport.serialize(stack)), stack)
	})

	test('parses a chain-specific Gnosis Safe address-book entry with an optional simulation signer', () => {
		const entry = AddressBookEntry.parse({
			type: 'safe',
			name: 'Treasury Gnosis Safe',
			address: '0x0000000000000000000000000000000000001234',
			chainId: '0x1',
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSimulationSignerAddress: '0x0000000000000000000000000000000000005678',
			safeSignerAddresses: [
				'0x0000000000000000000000000000000000009abc',
				'0x0000000000000000000000000000000000005678',
			],
			abi: '[]',
			safeVersion: '1.4.1',
		})

		assert.equal(entry.type, 'safe')
		assert.equal(entry.address, 0x1234n)
		assert.equal(entry.safeSimulationSignerAddress, 0x5678n)
		assert.deepEqual(getGnosisSafeSignerAddresses(entry), [0x9abcn, 0x5678n])
		assert.deepEqual(getGnosisSafeSignerAddresses({ ...entry, safeSimulationSignerAddress: 0x9abcn }), [0x9abcn, 0x5678n])
		assert.deepEqual(getGnosisSafeSignerAddresses({ ...entry, safeSimulationSignerAddress: 0xdef0n }), [0x9abcn, 0x5678n, 0xdef0n])
		assert.deepEqual(getGnosisSafeSignerAddresses({ ...entry, safeSignerAddresses: undefined }), [0x5678n])
		assert.equal(entry.abi, '[]')
	})

	test('keeps the current Gnosis Safe schema free of the removed signing-only owner field', () => {
		const entry = AddressBookEntry.parse({
			type: 'safe',
			name: 'Legacy Gnosis Safe',
			address: '0x0000000000000000000000000000000000001234',
			chainId: '0x1',
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddress: '0x0000000000000000000000000000000000005678',
		})

		assert.equal(entry.type, 'safe')
		assert.equal(entry.safeSimulationSignerAddress, undefined)
		assert.equal('safeSignerAddress' in entry, false)
	})

	test('reads Gnosis Safe metadata and validates configured EOA owners from its snapshot', async () => {
		const owner = 0x5678n
		const selectors = {
			version: encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []).slice(0, 10),
			nonce: encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []).slice(0, 10),
			owners: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []).slice(0, 10),
			threshold: encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', []).slice(0, 10),
		}
		const createEthereum = (contractOwner = false, version = '1.4.1') => ({
			async getBlockNumber() {
				return 123n
			},
			async getCode(address: bigint, blockTag: bigint | string) {
				assert.equal(blockTag, 123n)
				return address === 0x1234n || contractOwner ? new Uint8Array([1]) : new Uint8Array()
			},
			async call(transaction: { readonly input: Uint8Array }, blockTag: bigint | string) {
				assert.equal(blockTag, 123n)
				switch (bytesToHex(transaction.input).slice(0, 10)) {
					case selectors.version: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', [version])
					case selectors.nonce: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [3n])
					case selectors.owners: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [['0x0000000000000000000000000000000000005678']])
					case selectors.threshold: return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [2n])
					default: throw new Error('Unexpected Gnosis Safe call')
				}
			},
		})

		assert.deepEqual(await getGnosisSafeContractState(createEthereum(), 0x1234n), {
			version: '1.4.1',
			nonce: 3n,
			owners: [owner],
			threshold: 2n,
		})
		const snapshot = await getGnosisSafeContractSnapshot(createEthereum(), 0x1234n)
		await assert.doesNotReject(createGnosisSafeOwnerValidator(createEthereum(), 0x1234n, snapshot).assertEoaOwner(owner))
		assert.deepEqual((await validateGnosisSafeOwnerIsEoa(createEthereum(), 0x1234n, owner)).snapshot, snapshot)
		await assert.rejects(createGnosisSafeOwnerValidator(createEthereum(), 0x1234n, snapshot).assertEoaOwner(0x9abcn), /is not an owner of Gnosis Safe/u)
		await assert.rejects(
			validateGnosisSafeOwnerIsEoa(createEthereum(), 0x1234n, 0x9abcn),
			(error) => isGnosisSafeOwnerValidationFailure(error) && /is not an owner of Gnosis Safe/u.test(error.message),
		)
		await assert.rejects(createGnosisSafeOwnerValidator(createEthereum(true), 0x1234n, snapshot).assertEoaOwner(owner), /supports EOA owners only/u)
		await assert.rejects(
			validateGnosisSafeOwnerIsEoa(createEthereum(true), 0x1234n, owner),
			(error) => isGnosisSafeOwnerValidationFailure(error) && /supports EOA owners only/u.test(error.message),
		)
		await assert.rejects(
			getGnosisSafeContractState(createEthereum(false, '2.0.0'), 0x1234n),
			(error) => isGnosisSafeContractValidationFailure(error) && /version 2\.0\.0 is not supported/u.test(error.message),
		)
	})

	test('reuses the Gnosis Safe snapshot and owner-code result across repeated validations', async () => {
		let blockNumberReads = 0
		let ownerCodeReads = 0
		const blockTags: (bigint | string)[] = []
		const baseEthereum = {
			async getBlockNumber() {
				blockNumberReads += 1
				return 122n + BigInt(blockNumberReads)
			},
			async getCode(address: bigint, blockTag: bigint | string) {
				blockTags.push(blockTag)
				if (address !== 0x1234n) ownerCodeReads += 1
				return address === 0x1234n ? new Uint8Array([1]) : new Uint8Array()
			},
			async call(transaction: { readonly input: Uint8Array }, blockTag: bigint | string) {
				blockTags.push(blockTag)
				switch (bytesToHex(transaction.input).slice(0, 10)) {
					case encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []).slice(0, 10): return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', ['1.4.1'])
					case encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []).slice(0, 10): return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [3n])
					case encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []).slice(0, 10): return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [['0x0000000000000000000000000000000000005678']])
					case encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', []).slice(0, 10): return encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [2n])
					default: throw new Error('Unexpected Gnosis Safe call')
				}
			},
		}

		const snapshot = await getGnosisSafeContractSnapshot(baseEthereum, 0x1234n)
		const ownerValidator = createGnosisSafeOwnerValidator(baseEthereum, 0x1234n, snapshot)
		await Promise.all([
			ownerValidator.assertEoaOwner(0x5678n),
			ownerValidator.assertEoaOwner(0x5678n),
		])

		assert.equal(blockNumberReads, 1)
		assert.equal(ownerCodeReads, 1)
		assert.equal(snapshot.blockNumber, 123n)
		assert.equal(blockTags.every((blockTag) => blockTag === snapshot.blockNumber), true)
	})
})
