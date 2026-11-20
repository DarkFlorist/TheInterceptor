import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getSafeContractSnapshot, validateSafeOwnerIsEoa } from '../../safe/safeCore.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { SetSafeSimulationSigner } from '../../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getErrorMessage, reportUnexpectedError } from '../../utils/errors.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getUserAddressBookEntries, updateUserAddressBookEntries } from '../storageVariables.js'
import { getSettings } from '../settings.js'
import { updateWebsiteApprovalAccesses } from '../accessManagement.js'

export { importSafeStack, requestSafeStackExport, validateSafeTransactionStackForCurrentContract } from '../safeStackHandlers.js'

export async function setSafeSimulationSigner(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	request: SetSafeSimulationSigner,
) {
	const { ethereum } = simulationServicesOwner.getCurrent()
	if (request.data.chainId !== ethereum.getChainId()) {
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: `Switch Interceptor to chain ${ request.data.chainId.toString() } before changing the Safe simulation signer.`,
		}
	}
	const safeEntry = (await getUserAddressBookEntries()).find((entry) =>
		entry.type === 'safe' && entry.address === request.data.safeAddress && entry.chainId === request.data.chainId
	)
	if (safeEntry?.type !== 'safe') {
		return { type: 'SetSafeSimulationSignerReply' as const, ok: false as const, message: 'The Gnosis Safe address-book entry no longer exists.' }
	}
	let validatedSafeState: Awaited<ReturnType<typeof validateSafeOwnerIsEoa>>['snapshot']['state']
	try {
		const snapshot = request.data.safeSimulationSignerAddress === undefined
			? await getSafeContractSnapshot(ethereum, safeEntry.address)
			: (await validateSafeOwnerIsEoa(ethereum, safeEntry.address, request.data.safeSimulationSignerAddress)).snapshot
		validatedSafeState = snapshot.state
	} catch(error) {
		await reportUnexpectedError(error, {
			source: 'safe_simulation_signer',
			code: 'safe_simulation_signer_validation_failed',
			displayMessage: request.data.safeSimulationSignerAddress === undefined
				? 'Failed to refresh the Gnosis Safe owners.'
				: 'Failed to validate the Safe simulation signer.',
		})
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: getErrorMessage(error) ?? (request.data.safeSimulationSignerAddress === undefined
				? 'Failed to refresh the Gnosis Safe owners.'
				: 'The selected address is not a current wallet-signable Safe owner.'),
		}
	}
	let updatedEntry: AddressBookEntry | undefined
	await updateUserAddressBookEntries((entries) => entries.map((entry) => {
		if (entry.type !== 'safe' || entry.address !== request.data.safeAddress || entry.chainId !== request.data.chainId) return entry
		const { safeSimulationSignerAddress: _previousSafeSimulationSignerAddress, ...entryWithoutSimulationSigner } = entry
		updatedEntry = {
			...entryWithoutSimulationSigner,
			...(request.data.safeSimulationSignerAddress === undefined ? {} : { safeSimulationSignerAddress: request.data.safeSimulationSignerAddress }),
			safeSignerAddresses: [...validatedSafeState.owners],
			safeVersion: validatedSafeState.version,
		}
		return updatedEntry
	}))
	if (updatedEntry === undefined) {
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: 'The Gnosis Safe address-book entry no longer exists.',
		}
	}
	if (updatedEntry.useAsActiveAddress) {
		await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	return { type: 'SetSafeSimulationSignerReply' as const, ok: true as const }
}
