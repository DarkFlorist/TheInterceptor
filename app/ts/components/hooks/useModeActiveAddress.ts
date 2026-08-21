import { type ReadonlySignal, useComputed } from '@preact/signals'
import type { AddressBookEntries } from '../../types/addressBookTypes.js'
import type { RpcNetwork } from '../../types/rpc.js'
import type { TabState } from '../../types/user-interface-types.js'
import { getDisplayedSigningAddressSelection, getWalletSelectedAccount, resolveActiveAddressForMode } from '../../utils/activeAddressSelection.js'

type ModeActiveAddressSignals = {
	readonly activeAddresses: ReadonlySignal<AddressBookEntries>
	readonly simulationMode: ReadonlySignal<boolean>
	readonly activeSimulationAddress: ReadonlySignal<bigint | undefined>
	readonly activeSigningSafeAddress: ReadonlySignal<bigint | undefined>
	readonly displayedSigningAddress: ReadonlySignal<bigint | undefined>
	readonly rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	readonly tabState: ReadonlySignal<TabState | undefined>
}

export function useModeActiveAddress(signals: ModeActiveAddressSignals) {
	return useComputed(() => {
		const modeInput = signals.simulationMode.value
			? { mode: 'simulation' as const, activeAddress: signals.activeSimulationAddress.value }
			: {
				mode: 'signing' as const,
				selectedAddress: getDisplayedSigningAddressSelection(signals.displayedSigningAddress.value, signals.activeSigningSafeAddress.value),
				signerAccounts: signals.tabState.value?.signerAccounts ?? [],
				walletFallbackAddress: getWalletSelectedAccount(signals.tabState.value),
			}
		return resolveActiveAddressForMode(signals.activeAddresses.value, signals.rpcNetwork.value?.chainId, modeInput)
	})
}
