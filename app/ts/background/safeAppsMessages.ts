import * as funtypes from 'funtypes'
import { JsonValue } from '../types/safeApps.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { assertSafeMessageSignatureValid, createSafeMessageTypedData, parseSafeTypedMessage } from '../safe/safeMessage.js'
import { createSafeOwnerValidator, getSafeContractSnapshot } from '../safe/safeCore.js'
import { hashTypedData } from '../utils/ethereumPrimitives.js'
import { addressString } from '../utils/bigint.js'
import { requestSafeAppsGateway, safeAppsServiceError } from './safeAppsGateway.js'

export type SafeAppsMessageServices = {
	readonly submit: (message: string, signature: string, isTypedData?: boolean) => Promise<{ messageHash: string }>
	readonly getSignature: (messageHash: string) => Promise<string>
}

const GatewayMessage = funtypes.ReadonlyObject({
	messageHash: funtypes.String,
	message: JsonValue,
	confirmations: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ signature: funtypes.String })),
})

async function requestMessageService(path: string, body?: { message?: JsonValue, signature: string }, allowMissing = false) {
	const result = await requestSafeAppsGateway(path, 'message', body, allowMissing)
	if (result === undefined) return undefined
	const parsed = GatewayMessage.safeParse(result)
	if (!parsed.success) throw safeAppsServiceError('The Safe message service returned an invalid message response.')
	return parsed.value
}

export function createSafeAppsMessageServices(ethereum: EthereumClientService, safeAddress: bigint, chainId: bigint): SafeAppsMessageServices {
	const getSnapshot = async () => {
		if (ethereum.getChainId() !== chainId) throw safeAppsServiceError('The active chain changed. Request the Safe message again.')
		return await getSafeContractSnapshot(ethereum, safeAddress)
	}
	const hashMessage = (message: JsonValue) => hashTypedData(createSafeMessageTypedData(chainId, safeAddress, typeof message === 'string' ? message : JSON.stringify(message), typeof message !== 'string'))
	return {
		async submit(message, signature, isTypedData = false) {
			const serviceMessage = isTypedData ? JsonValue.parse(parseSafeTypedMessage(message)) : message
			const snapshot = await getSnapshot()
			const messageHash = hashMessage(serviceMessage)
			const owner = await createSafeOwnerValidator(ethereum, safeAddress, snapshot).validateSignature(BigInt(messageHash), signature)
			const path = `chains/${ chainId.toString() }/messages/${ messageHash }`
			const existing = await requestMessageService(path, undefined, true)
			if (existing !== undefined && (existing.messageHash !== messageHash || hashMessage(existing.message) !== messageHash)) throw safeAppsServiceError('The Safe message service returned a different message.')
			if (existing === undefined) await requestMessageService(`chains/${ chainId.toString() }/safes/${ addressString(safeAddress) }/messages`, { message: serviceMessage, signature: owner.signature })
			else if (!existing.confirmations.some((confirmation) => confirmation.signature.toLowerCase() === owner.signature.toLowerCase())) await requestMessageService(`${ path }/signatures`, { signature: owner.signature })
			return { messageHash }
		},
		async getSignature(messageHash) {
			const stored = await requestMessageService(`chains/${ chainId.toString() }/messages/${ messageHash }`)
			if (stored === undefined || stored.messageHash !== messageHash || hashMessage(stored.message) !== messageHash) throw safeAppsServiceError('The Safe message does not match the active account and chain.')
			const snapshot = await getSnapshot()
			const validator = createSafeOwnerValidator(ethereum, safeAddress, snapshot)
			const owners = await Promise.all(stored.confirmations.map(async ({ signature }) => await validator.validateSignature(BigInt(messageHash), signature)))
			const uniqueOwners = new Map(owners.map((owner) => [owner.signer, owner]))
			// The SDK uses an empty signature as the normal polling result until enough owners have confirmed.
			if (BigInt(uniqueOwners.size) < snapshot.state.threshold) return ''
			const signature = `0x${ [...uniqueOwners.values()].sort((a, b) => a.signer < b.signer ? -1 : 1).slice(0, Number(snapshot.state.threshold)).map(({ signature }) => signature.slice(2)).join('') }`
			await assertSafeMessageSignatureValid(ethereum, safeAddress, typeof stored.message === 'string' ? stored.message : JSON.stringify(stored.message), signature, snapshot.blockNumber, typeof stored.message !== 'string')
			return signature
		},
	}
}
