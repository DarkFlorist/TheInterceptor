import { addr } from 'micro-eth-signer'
import { concatBytes } from '@noble/hashes/utils'
import { bytesFromHex, bytesToHex, getAddress, type Hex } from '../utils/ethereumBytes.js'
import { assembleSignedTransaction, preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload, verifyPersonalSigningResponse, verifyTypedDataSigningResponse, type PersonalSigningPayload, type TransactionSigningPayload, type TypedDataSigningPayload } from './exactPayload.js'
import { encodeLedgerDerivationPath } from './ledgerFraming.js'
import { compileLedgerTypedData, type LedgerCommand } from './ledgerTypedData.js'
import type { LedgerExchange } from './ledgerHid.js'

export type LedgerPublicAccount = Readonly<{ address: Hex, publicKey: Hex, derivationPath: string }>

export async function checkLedgerEthereumApp(exchange: LedgerExchange) {
	const configuration = await exchange({ instruction: 6, p1: 0, p2: 0, data: new Uint8Array() })
	const [flags, major, minor, patch] = configuration
	if (configuration.length !== 4 || flags === undefined || major === undefined || minor === undefined || patch === undefined) throw new Error('Open the Ethereum app on your Ledger')
	if (major < 1 || (major === 1 && (minor < 9 || (minor === 9 && patch < 19)))) throw new Error('Update the Ledger Ethereum app to version 1.9.19 or newer for direct signing')
	return { version: `${ major }.${ minor }.${ patch }`, blindSigningEnabled: (flags & 1) !== 0 }
}

export async function readLedgerAccount(exchange: LedgerExchange, derivationPath: string, displayOnDevice: boolean, expectedAddress?: string): Promise<LedgerPublicAccount> {
	const response = await exchange({ instruction: 2, p1: displayOnDevice ? 1 : 0, p2: 0, data: encodeLedgerDerivationPath(derivationPath) })
	if (response.length !== 107 || response[0] !== 65 || response[1] !== 4 || response[66] !== 40) throw new Error('Malformed Ledger public-account response')
	const publicKey = bytesToHex(response.slice(1, 66))
	const address = getAddress(`0x${ new TextDecoder('ascii', { fatal: true }).decode(response.slice(67)) }`)
	if (getAddress(addr.fromPublicKey(bytesFromHex(publicKey))) !== address) throw new Error('Ledger address does not match its public key')
	if (expectedAddress !== undefined && address !== getAddress(expectedAddress)) throw new Error('This Ledger does not contain the expected account. Connect the saved wallet and use its saved derivation path.')
	return Object.freeze({ address, publicKey, derivationPath })
}

function normalizeLedgerSignature(response: Uint8Array): Hex {
	if (response.length !== 65) throw new Error('Malformed Ledger signature response')
	const recovery = response[0]
	if (recovery !== 0 && recovery !== 1 && recovery !== 27 && recovery !== 28) throw new Error('Invalid Ledger signature recovery byte')
	return bytesToHex(concatBytes(response.subarray(1), Uint8Array.of(recovery < 27 ? recovery + 27 : recovery)))
}

function chunkSigningCommand(instruction: number, prefix: Uint8Array, payload: Uint8Array): readonly LedgerCommand[] {
	const input = concatBytes(prefix, payload)
	const commands: LedgerCommand[] = []
	for (let offset = 0; offset < input.length; offset += 255) commands.push({ instruction, p1: offset === 0 ? 0 : 0x80, p2: 0, data: input.slice(offset, offset + 255) })
	return commands
}

/** Whole operation must run inside withLedgerDevice, including account verification and every streamed command. */
export async function signWithLedger(exchange: LedgerExchange, account: LedgerPublicAccount, payload: TransactionSigningPayload | PersonalSigningPayload | TypedDataSigningPayload): Promise<Hex> {
	if (getAddress(account.address) !== getAddress(payload.expectedAddress)) throw new Error('Ledger binding does not match the request account')
	let commands: readonly LedgerCommand[]
	if (payload.method === 'eth_signTypedData_v4') {
		const prepared = prepareTypedDataSigningPayload(payload.typedDataJson, payload.expectedAddress, payload.chainId)
		if (prepared.digest !== payload.digest || prepared.domainChainId !== payload.domainChainId) throw new Error('Typed-data payload changed before Ledger signing')
		commands = compileLedgerTypedData(payload.typedDataJson, account.derivationPath)
	} else if (payload.method === 'personal_sign') {
		if (preparePersonalSigningPayload(payload.message, payload.expectedAddress).digest !== payload.digest) throw new Error('Message changed before Ledger signing')
		const message = bytesFromHex(payload.message)
		const length = new Uint8Array(4)
		new DataView(length.buffer).setUint32(0, message.length)
		commands = chunkSigningCommand(8, concatBytes(encodeLedgerDerivationPath(account.derivationPath), length), message)
	} else {
		if (prepareTransactionSigningPayload(payload.unsignedTransaction, payload.expectedAddress, payload.chainId).digest !== payload.digest) throw new Error('Transaction changed before Ledger signing')
		commands = chunkSigningCommand(4, encodeLedgerDerivationPath(account.derivationPath), bytesFromHex(payload.unsignedTransaction))
	}
	await checkLedgerEthereumApp(exchange)
	const connected = await readLedgerAccount(exchange, account.derivationPath, false, payload.expectedAddress)
	if (connected.publicKey.toLowerCase() !== account.publicKey.toLowerCase()) throw new Error('Ledger public key differs from the saved account')
	let response: Uint8Array = new Uint8Array()
	for (const [index, command] of commands.entries()) {
		response = await exchange(command)
		if (index < commands.length - 1 && response.length !== 0) throw new Error('Ledger returned a signature before receiving the complete payload')
	}
	const signature = normalizeLedgerSignature(response)
	if (payload.method === 'eth_sendTransaction') return await assembleSignedTransaction(payload, signature)
	if (payload.method === 'personal_sign') return await verifyPersonalSigningResponse(payload, signature)
	return await verifyTypedDataSigningResponse(payload, signature)
}
