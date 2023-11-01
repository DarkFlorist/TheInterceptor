import { StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBlockHeader, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, SimulationUpdatingState, SimulationResultState, SignedMessageTransaction, MaybeParsedEvents } from './visualizer-types.js'
import { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { ActiveAddress, ActiveAddressEntry, AddressBookEntry, IncompleteAddressBookEntry } from './addressBookTypes.js'
import { Page } from './exportedSettingsTypes.js'
import { Website, WebsiteAccessArray } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { ICON_ACCESS_DENIED, ICON_ACTIVE, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING } from '../utils/constants.js'
import { RpcEntries, RpcEntry, RpcNetwork } from './rpc.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'

export type AddressListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setActiveAddresss: StateUpdater<readonly ActiveAddress[]>,
	activeAddresses: readonly ActiveAddress[],
}

export type InterceptorAccessListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setWebsiteAccess: StateUpdater<WebsiteAccessArray | undefined>,
	websiteAccess: WebsiteAccessArray | undefined,
	websiteAccessAddressMetadata: readonly ActiveAddressEntry[],
	renameAddressCallBack: RenameAddressCallBack,
}

export type AddAddressParam = {
	close: () => void,
	setActiveAddressAndInformAboutIt: ((address: bigint | 'signer') => Promise<void>) | undefined,
	incompleteAddressBookEntry: IncompleteAddressBookEntry,
	activeAddress: bigint | undefined,
}

export type HomeParams = {
	setAndSaveAppPage: (page: Page) => void,
	makeMeRich: boolean,
	activeAddresses: readonly ActiveAddress[],
	signerAccounts: readonly bigint[] | undefined,
	activeSimulationAddress: bigint | undefined,
	activeSigningAddress: bigint | undefined,
	useSignersAddressAsActiveAddress: boolean,
	simVisResults: SimulationAndVisualisationResults | undefined,
	rpcNetwork: RpcNetwork | undefined,
	setActiveRpcAndInformAboutIt: (entry: RpcEntry) => void,
	simulationMode: boolean,
	tabIconDetails: TabIconDetails,
	currentBlockNumber: bigint | undefined,
	signerName: SignerName,
	renameAddressCallBack: RenameAddressCallBack,
	rpcConnectionStatus: RpcConnectionStatus,
	rpcEntries: RpcEntries,
	simulationUpdatingState: SimulationUpdatingState | undefined,
	simulationResultState: SimulationResultState | undefined,
}

export type ChangeActiveAddressParam = {
	activeAddresses: readonly ActiveAddress[]
	setAndSaveAppPage: (page: Page) => void,
	setActiveAddressAndInformAboutIt: (address: bigint | 'signer') => void,
	signerAccounts: readonly bigint[] | undefined,
	signerName: SignerName,
	renameAddressCallBack: RenameAddressCallBack,
	addNewAddress: () => void,
}

export type SettingsParam = {
	useTabsInsteadOfPopup: boolean | undefined,
	metamaskCompatibilityMode: boolean | undefined,
	setAndSaveAppPage: (page: Page) => void
}

export type FirstCardParams = {
	activeAddress: ActiveAddress | undefined,
	enableSimulationMode: (x: boolean) => void,
	useSignersAddressAsActiveAddress: boolean,
	activeAddresses: readonly ActiveAddress[] | undefined,
	changeActiveRpc: (rpcEntry: RpcEntry) => void,
	rpcNetwork: RpcNetwork,
	simulationMode: boolean,
	changeActiveAddress: () => void,
	makeMeRich: boolean,
	signerAccounts: readonly bigint[] | undefined,
	tabIconDetails: TabIconDetails,
	signerName: SignerName,
	renameAddressCallBack: RenameAddressCallBack,
	rpcEntries: RpcEntries,
}

export type SimulationStateParam = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults | undefined
	removeTransaction: (tx: SimulatedAndVisualizedTransaction) => void
	removeSignedMessage: (message: VisualizedPersonalSignRequest) => void
	currentBlockNumber: bigint | undefined
	renameAddressCallBack: RenameAddressCallBack
	disableReset: boolean
	resetSimulation: () => void
	removedTransactionHashes: readonly bigint[]
	removedSignedMessages: readonly UniqueRequestIdentifier[]
	rpcConnectionStatus: RpcConnectionStatus
	simulationUpdatingState: SimulationUpdatingState | undefined
	simulationResultState: SimulationResultState | undefined
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type NonLogAnalysisParams = {
	nonTokenLogs: MaybeParsedEvents
}

export type RenameAddressCallBack = (addressBookEntry: AddressBookEntry) => void

export type SocketConnection = {
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

export type WindowOrTabId = funtypes.Static<typeof WindowOrTabId>
export const WindowOrTabId = funtypes.ReadonlyObject({
	id: funtypes.Number,
	type: funtypes.Union(funtypes.Literal('tab'), funtypes.Literal('window'))
})

export type TabState = funtypes.Static<typeof TabState>
export const TabState = funtypes.ReadonlyObject({
	signerName: SignerName,
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
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
}))

export type PendingChainChangeConfirmationPromise = funtypes.Static<typeof PendingChainChangeConfirmationPromise>
export const PendingChainChangeConfirmationPromise = funtypes.ReadonlyObject({
	website: Website,
	dialogId: funtypes.Number,
	request: InterceptedRequest,
	rpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
})

export type PendingPersonalSignPromise = funtypes.Static<typeof PendingPersonalSignPromise>
export const PendingPersonalSignPromise = funtypes.ReadonlyObject({
	dialogId: funtypes.Number,
	signedMessageTransaction: SignedMessageTransaction,
})
