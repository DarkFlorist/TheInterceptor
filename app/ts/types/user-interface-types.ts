import { Dispatch, StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBlockHeader, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, SimulationUpdatingState, SimulationResultState, ModifyAddressWindowState, BlockTimeManipulation } from './visualizer-types.js'
import { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { AddressBookEntries, AddressBookEntry } from './addressBookTypes.js'
import { PopupOrTabId, Website, WebsiteAccessArray } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { ICON_ACCESS_DENIED, ICON_ACCESS_DENIED_WITH_SHIELD, ICON_ACTIVE, ICON_ACTIVE_WITH_SHIELD, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD, ICON_SIGNING_WITH_SHIELD, ICON_SIMULATING, ICON_SIMULATING_WITH_SHIELD } from '../utils/constants.js'
import { RpcEntries, RpcEntry, RpcNetwork } from './rpc.js'
import { TransactionOrMessageIdentifier } from './interceptor-messages.js'
import { EditEnsNamedHashCallBack } from '../components/subcomponents/ens.js'
import { EnrichedEthereumEventWithMetadata } from './EnrichedEthereumData.js'
import { ReadonlySignal, Signal } from '@preact/signals'
import { SimulationStackVersion } from './JsonRpc-types.js'
import { EnrichedRichListElement } from './interceptor-reply-messages.js'
import { ErrorWithCodeAndOptionalData } from './error.js'

export type InterceptorAccessListParams = {
	goHome: () => void,
	setWebsiteAccess: Dispatch<StateUpdater<WebsiteAccessArray | undefined>>,
	websiteAccess: WebsiteAccessArray | undefined,
	websiteAccessAddressMetadata: AddressBookEntries,
	renameAddressCallBack: RenameAddressCallBack,
}

export type AddAddressParam = {
	close: () => void
	setActiveAddressAndInformAboutIt: ((address: bigint | 'signer') => Promise<void>) | undefined
	modifyAddressWindowState: Signal<ModifyAddressWindowState>
	activeAddress: bigint | undefined
	rpcEntries: Signal<RpcEntries>
}

export type HomeParams = {
	changeActiveAddress: () => void
	makeCurrentAddressRich: Signal<boolean>
	activeAddresses: Signal<AddressBookEntries>
	tabState: TabState | undefined
	activeSimulationAddress: Signal<bigint | undefined>
	activeSigningAddress: Signal<bigint | undefined>
	useSignersAddressAsActiveAddress: boolean
	simVisResults: SimulationAndVisualisationResults | undefined
	rpcNetwork: Signal<RpcNetwork | undefined>
	setActiveRpcAndInformAboutIt: (entry: RpcEntry) => void
	simulationMode: Signal<boolean>
	tabIconDetails: TabIconDetails
	currentBlockNumber: bigint | undefined
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	rpcConnectionStatus: Signal<RpcConnectionStatus>
	rpcEntries: Signal<RpcEntries>
	simulationUpdatingState: SimulationUpdatingState | undefined
	simulationResultState: SimulationResultState | undefined
	interceptorDisabled: boolean
	preSimulationBlockTimeManipulation: Signal<BlockTimeManipulation | undefined>
	fixedAddressRichList: Signal<readonly EnrichedRichListElement[]>
	openImportSimulation: () => void
}

export type ChangeActiveAddressParam = {
	activeAddresses: Signal<AddressBookEntries>
	close: () => void,
	setActiveAddressAndInformAboutIt: (address: bigint | 'signer') => void,
	signerAccounts: readonly bigint[] | undefined,
	signerName: SignerName,
	renameAddressCallBack: RenameAddressCallBack,
	addNewAddress: () => void,
}

export type FirstCardParams = {
	activeAddress: Signal<AddressBookEntry | undefined>
	useSignersAddressAsActiveAddress: boolean
	activeAddresses: Signal<AddressBookEntries | undefined>
	changeActiveRpc: (rpcEntry: RpcEntry) => void
	rpcNetwork: Signal<RpcNetwork | undefined>
	simulationMode: Signal<boolean>
	changeActiveAddress: () => void
	makeCurrentAddressRich: Signal<boolean>
	richList: Signal<readonly EnrichedRichListElement[]>
	tabIconDetails: TabIconDetails,
	tabState: TabState | undefined,
	renameAddressCallBack: RenameAddressCallBack,
	rpcEntries: Signal<RpcEntries>,
	preSimulationBlockTimeManipulation: Signal<BlockTimeManipulation | undefined>
}

export type SimulationStateParam = {
	simulationAndVisualisationResults: ReadonlySignal<SimulationAndVisualisationResults | undefined>
	removeTransactionOrSignedMessage: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	currentBlockNumber: bigint | undefined
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	disableReset: boolean
	resetSimulation: () => void
	removedTransactionOrSignedMessages: readonly TransactionOrMessageIdentifier[]
	rpcConnectionStatus: Signal<RpcConnectionStatus>
	simulationUpdatingState: SimulationUpdatingState | undefined
	simulationResultState: SimulationResultState | undefined
	openImportSimulation: () => void
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type NonLogAnalysisParams = {
	nonTokenLogs: readonly EnrichedEthereumEventWithMetadata[]
	addressMetaData: readonly AddressBookEntry[]
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

export type RenameAddressCallBack = (addressBookEntry: AddressBookEntry) => void

type SocketConnection = {
	port: browser.runtime.Port,
	socket: WebsiteSocket,
	websiteOrigin: string,
	approved: boolean, // if user has approved connection
	wantsToConnect: boolean,
}

export type TabIcon = funtypes.Static<typeof TabIcon>
export const TabIcon = funtypes.Union(
	funtypes.Literal(ICON_ACTIVE),
	funtypes.Literal(ICON_ACCESS_DENIED),
	funtypes.Literal(ICON_NOT_ACTIVE),
	funtypes.Literal(ICON_SIMULATING),
	funtypes.Literal(ICON_SIGNING),
	funtypes.Literal(ICON_SIGNING_NOT_SUPPORTED),
	funtypes.Literal(ICON_INTERCEPTOR_DISABLED),

	funtypes.Literal(ICON_ACTIVE_WITH_SHIELD),
	funtypes.Literal(ICON_ACCESS_DENIED_WITH_SHIELD),
	funtypes.Literal(ICON_NOT_ACTIVE_WITH_SHIELD),
	funtypes.Literal(ICON_SIMULATING_WITH_SHIELD),
	funtypes.Literal(ICON_SIGNING_WITH_SHIELD),
	funtypes.Literal(ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD),
)

export type TabIconDetails = funtypes.Static<typeof TabIconDetails>
export const TabIconDetails = funtypes.ReadonlyObject({
	icon: TabIcon,
	iconReason: funtypes.String,
})

export type TabConnection = {
	connections: Record<string, SocketConnection> // socket as string
}

export type WebsiteTabConnections = Map<number, TabConnection>

export type TabState = funtypes.Static<typeof TabState>
export const TabState = funtypes.ReadonlyObject({
	tabId: funtypes.Number,
	website: funtypes.Union(Website, funtypes.Undefined),
	signerConnected: funtypes.Boolean,
	signerName: SignerName,
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
	signerAccountError: funtypes.Union(ErrorWithCodeAndOptionalData, funtypes.Undefined),
	signerChain: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	tabIconDetails: TabIconDetails,
	activeSigningAddress: OptionalEthereumAddress,
})

export type RpcConnectionStatus = funtypes.Static<typeof RpcConnectionStatus>
export const RpcConnectionStatus = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	isConnected: funtypes.Boolean,
	lastConnnectionAttempt: EthereumTimestamp,
	rpcNetwork: RpcNetwork,
	latestBlock: funtypes.Union(funtypes.Undefined, EthereumBlockHeader),
	retrying: funtypes.Boolean,
}))

export type PendingChainChangeConfirmationPromise = funtypes.Static<typeof PendingChainChangeConfirmationPromise>
export const PendingChainChangeConfirmationPromise = funtypes.ReadonlyObject({
	website: Website,
	popupOrTabId: PopupOrTabId,
	request: InterceptedRequest,
	rpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
})

export type PendingFetchSimulationStackRequestPromise = funtypes.Static<typeof PendingFetchSimulationStackRequestPromise>
export const PendingFetchSimulationStackRequestPromise = funtypes.ReadonlyObject({
	website: Website,
	popupOrTabId: PopupOrTabId,
	simulationStackVersion: SimulationStackVersion,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
})
