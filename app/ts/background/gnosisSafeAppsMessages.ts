import * as funtypes from 'funtypes'
import { JsonValue } from '../types/gnosisSafeApps.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { assertGnosisSafeMessageSignatureValid, createGnosisSafeMessageTypedData, parseGnosisSafeTypedMessage } from '../gnosisSafe/gnosisSafeMessage.js'
import { createGnosisSafeOwnerValidator, getGnosisSafeContractSnapshot } from '../gnosisSafe/gnosisSafeCore.js'
import { hashTypedData } from '../utils/ethereumPrimitives.js'
import { addressString } from '../utils/bigint.js'
import { requestGnosisSafeAppsGateway, gnosisSafeAppsServiceError } from './gnosisSafeAppsGateway.js'

export type GnosisSafeAppsMessageServices = {
	readonly submit: (message: string, signature: string, isTypedData?: boolean) => Promise<{ messageHash: string }>
	readonly getSignature: (messageHash: string) => Promise<string>
}

const GatewayMessage = funtypes.ReadonlyObject({
	messageHash: funtypes.String,
	message: JsonValue,
	confirmations: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ signature: funtypes.String })),
})

async function requestMessageService(path: string, body?: { message?: JsonValue, signature: string }, allowMissing = false) {
	const result = await requestGnosisSafeAppsGateway(path, 'message', body, allowMissing)
	if (result === undefined) return undefined
	const parsed = GatewayMessage.safeParse(result)
	if (!parsed.success) throw gnosisSafeAppsServiceError('The Gnosis Safe message service returned an invalid message response.')
	return parsed.value
}

export function createGnosisSafeAppsMessageServices(ethereum: EthereumClientService, safeAddress: bigint, chainId: bigint): GnosisSafeAppsMessageServices {
	const getSnapshot = async () => {
		if (ethereum.getChainId() !== chainId) throw gnosisSafeAppsServiceError('The active chain changed. Request the Gnosis Safe message again.')
		return await getGnosisSafeContractSnapshot(ethereum, safeAddress)
	}
	const hashMessage = (message: JsonValue) => hashTypedData(createGnosisSafeMessageTypedData(chainId, safeAddress, typeof message === 'string' ? message : JSON.stringify(message), typeof message !== 'string'))
	return {
		async submit(message, signature, isTypedData = false) {
			const serviceMessage = isTypedData ? JsonValue.parse(parseGnosisSafeTypedMessage(message)) : message
			const snapshot = await getSnapshot()
			const messageHash = hashMessage(serviceMessage)
			const owner = await createGnosisSafeOwnerValidator(ethereum, safeAddress, snapshot).validateSignature(BigInt(messageHash), signature)
			const path = `chains/${ chainId.toString() }/messages/${ messageHash }`
			const existing = await requestMessageService(path, undefined, true)
			if (existing !== undefined && (existing.messageHash !== messageHash || hashMessage(existing.message) !== messageHash)) throw gnosisSafeAppsServiceError('The Gnosis Safe message service returned a different message.')
			if (existing === undefined) await requestMessageService(`chains/${ chainId.toString() }/safes/${ addressString(safeAddress) }/messages`, { message: serviceMessage, signature: owner.signature })
			else if (!existing.confirmations.some((confirmation) => confirmation.signature.toLowerCase() === owner.signature.toLowerCase())) await requestMessageService(`${ path }/signatures`, { signature: owner.signature })
			return { messageHash }
		},
		async getSignature(messageHash) {
			const stored = await requestMessageService(`chains/${ chainId.toString() }/messages/${ messageHash }`)
			if (stored === undefined || stored.messageHash !== messageHash || hashMessage(stored.message) !== messageHash) throw gnosisSafeAppsServiceError('The Gnosis Safe message does not match the active account and chain.')
			const snapshot = await getSnapshot()
			const validator = createGnosisSafeOwnerValidator(ethereum, safeAddress, snapshot)
			const owners = await Promise.all(stored.confirmations.map(async ({ signature }) => await validator.validateSignature(BigInt(messageHash), signature)))
			const uniqueOwners = new Map(owners.map((owner) => [owner.signer, owner]))
			// The SDK uses an empty signature as the normal polling result until enough owners have confirmed.
			if (BigInt(uniqueOwners.size) < snapshot.state.threshold) return ''
			const signature = `0x${ [...uniqueOwners.values()].sort((a, b) => a.signer < b.signer ? -1 : 1).slice(0, Number(snapshot.state.threshold)).map(({ signature }) => signature.slice(2)).join('') }`
			await assertGnosisSafeMessageSignatureValid(ethereum, safeAddress, typeof stored.message === 'string' ? stored.message : JSON.stringify(stored.message), signature, snapshot.blockNumber, typeof stored.message !== 'string')
			return signature
		},
	}
}
