import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBlockHeader, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import type { SimulatedAndVisualizedTransaction, ResolvedSimulationResults, SimulationUpdatingState, SimulationResultState, ModifyAddressWindowState, BlockTimeManipulation } from './visualizer-types.js'
import type { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { InterceptedRequest, UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { type AddressBookEntries, type AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from './addressBookTypes.js'
import { PopupOrTabId, Website, type WebsiteAccessArray } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { ICON_ACCESS_DENIED, ICON_ACTIVE, ICON_ACTIVE_WITH_SHIELD, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIGNING_NOT_SUPPORTED_WITH_SHIELD, ICON_SIGNING_WITH_SHIELD, ICON_SIMULATING, ICON_SIMULATING_WITH_SHIELD } from '../utils/constants.js'
import { type RpcEntries, type RpcEntry, RpcNetwork } from './rpc.js'
import type { TransactionOrMessageIdentifier } from './interceptor-messages.js'
import type { EditEnsNamedHashCallBack } from '../components/subcomponents/ens.js'
import type { EnrichedEthereumEventWithMetadata } from './EnrichedEthereumData.js'
import type { ReadonlySignal, Signal } from '@preact/signals'
import { SimulationStackVersion, WalletWatchAssetParameters } from './JsonRpc-types.js'
import type { EnrichedRichListElement } from './interceptor-reply-messages.js'
import { ErrorWithCodeAndOptionalData } from './error.js'
import type { RichTokenOption } from './richMode.js'

export type InterceptorAccessListParams = {
	goHome: () => void,
	websiteAccess: Signal<WebsiteAccessArray | undefined>,
	websiteAccessAddressMetadata: Signal<AddressBookEntries>,
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
	richNativeAmount: Signal<bigint>
	activeAddresses: Signal<AddressBookEntries>
	tabState: Signal<TabState | undefined>
	activeSimulationAddress: Signal<bigint | undefined>
	activeSigningAddress: Signal<bigint | undefined>
	useSignersAddressAsActiveAddress: Signal<boolean>
	simVisResults: Signal<ResolvedSimulationResults>
	rpcNetwork: Signal<RpcNetwork | undefined>
	setActiveRpcAndInformAboutIt: (entry: RpcEntry) => void
	simulationMode: Signal<boolean>
	tabIconDetails: Signal<TabIconDetails>
	currentBlockNumber: Signal<bigint | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	rpcConnectionStatus: Signal<RpcConnectionStatus>
	rpcEntries: Signal<RpcEntries>
	simulationUpdatingState: Signal<SimulationUpdatingState | undefined>
	simulationResultState: Signal<SimulationResultState | undefined>
	interceptorDisabled: Signal<boolean>
	preSimulationBlockTimeManipulation: Signal<BlockTimeManipulation | undefined>
	fixedAddressRichList: Signal<readonly EnrichedRichListElement[]>
	richTokenOptions: Signal<readonly RichTokenOption[]>
	numberOfAddressesMadeRich: Signal<number>
	isInitialHomeDataLoaded: Signal<boolean>
	isFreshHomeDataLoaded: Signal<boolean>
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
	useSignersAddressAsActiveAddress: Signal<boolean>
	activeAddresses: Signal<AddressBookEntries | undefined>
	changeActiveRpc: (rpcEntry: RpcEntry) => void
	rpcNetwork: Signal<RpcNetwork | undefined>
	simulationMode: Signal<boolean>
	changeActiveAddress: () => void
	makeCurrentAddressRich: Signal<boolean>
	richNativeAmount: Signal<bigint>
	richList: Signal<readonly EnrichedRichListElement[]>
	richTokenOptions: Signal<readonly RichTokenOption[]>
	tabIconDetails: Signal<TabIconDetails>
	tabState: Signal<TabState | undefined>
	renameAddressCallBack: RenameAddressCallBack,
	rpcEntries: Signal<RpcEntries>,
	preSimulationBlockTimeManipulation: Signal<BlockTimeManipulation | undefined>
	isInitialHomeDataLoaded: Signal<boolean>
	isFreshHomeDataLoaded: Signal<boolean>
}

export type SimulationStateParam = {
	simulationAndVisualisationResults: ReadonlySignal<ResolvedSimulationResults>
	removeTransactionOrSignedMessage: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	currentBlockNumber: Signal<bigint | undefined>
	activeSimulationAddress: Signal<bigint | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	disableReset: ReadonlySignal<boolean>
	resetSimulation: () => Promise<void>
	removedTransactionOrSignedMessages: readonly TransactionOrMessageIdentifier[]
	rpcConnectionStatus: Signal<RpcConnectionStatus>
	simulationUpdatingState: Signal<SimulationUpdatingState | undefined>
	simulationResultState: Signal<SimulationResultState | undefined>
	openSimulationStack: (target?: TransactionOrMessageIdentifier) => void
	numberOfAddressesMadeRich: Signal<number>
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type NonLogAnalysisParams = {
	nonTokenLogs: readonly EnrichedEthereumEventWithMetadata[]
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
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

export type SignerStateOwner = {
	// The owner lifecycle remains allocated after disconnect so its generation stays monotonic.
	connectionName?: bigint
	confirmed: boolean
	generation: number
	providerGeneration?: number
	confirmation?: {
		readonly promise: Promise<void>
		readonly resolve: () => void
	}
}

export type TabConnection = {
	connections: Record<string, SocketConnection> // socket as string
	// Signer ownership is a separate lifecycle from the passive page connection registry.
	signerStateOwner?: SignerStateOwner
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

export type RpcSlowRequest = funtypes.Static<typeof RpcSlowRequest>
export const RpcSlowRequest = funtypes.ReadonlyObject({
	method: funtypes.String,
	startedAt: EthereumTimestamp,
})

export type RpcConnectionStatus = funtypes.Static<typeof RpcConnectionStatus>
export const RpcConnectionStatus = funtypes.Union(funtypes.Undefined, funtypes.Intersect(
	funtypes.ReadonlyObject({
		isConnected: funtypes.Boolean,
		lastConnnectionAttempt: EthereumTimestamp,
		rpcNetwork: RpcNetwork,
		latestBlock: funtypes.Union(funtypes.Undefined, EthereumBlockHeader),
		retrying: funtypes.Boolean,
	}),
	funtypes.ReadonlyPartial({
		slowRequest: RpcSlowRequest,
	}),
))

export type PendingChainChangeConfirmationPromise = funtypes.Static<typeof PendingChainChangeConfirmationPromise>
export const PendingChainChangeConfirmationPromise = funtypes.ReadonlyObject({
	website: Website,
	popupOrTabId: PopupOrTabId,
	request: InterceptedRequest,
	rpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
})

type WatchAssetToken = funtypes.Static<typeof WatchAssetToken>
const WatchAssetToken = funtypes.Union(Erc20TokenEntry, Erc721Entry, Erc1155Entry)
type WatchAssetForwardingStatus = funtypes.Static<typeof WatchAssetForwardingStatus>
const WatchAssetForwardingStatus = funtypes.Union(
	funtypes.ReadonlyObject({ status: funtypes.Literal('pending') }),
	funtypes.ReadonlyObject({ status: funtypes.Literal('completed'), accepted: funtypes.Boolean }),
	funtypes.ReadonlyObject({ status: funtypes.Literal('error'), code: funtypes.Number, message: funtypes.String }),
)
type WatchAssetRequestDetails = {
	readonly website: Website
	readonly request: InterceptedRequest
	readonly requestedAsset: WalletWatchAssetParameters
	readonly currentToken: WatchAssetToken
	readonly token: WatchAssetToken
	readonly proposedImageUrl: string | undefined
	readonly selectedImageUri: string | undefined
	readonly imageDownloadError: string | undefined
	readonly forwardToSigner: {
		readonly signerName: funtypes.Static<typeof SignerName>
		readonly connectionName: bigint
		readonly ownerGeneration: number
		readonly signerProviderGeneration: number
	} | undefined
	readonly forwardingStatus: WatchAssetForwardingStatus | undefined
}
const WatchAssetRequestDetails: funtypes.Codec<WatchAssetRequestDetails> = funtypes.ReadonlyObject({
	website: Website,
	request: InterceptedRequest,
	requestedAsset: WalletWatchAssetParameters,
	currentToken: WatchAssetToken,
	token: WatchAssetToken,
	proposedImageUrl: funtypes.Union(funtypes.String, funtypes.Undefined),
	selectedImageUri: funtypes.Union(funtypes.String, funtypes.Undefined),
	imageDownloadError: funtypes.Union(funtypes.String, funtypes.Undefined),
	forwardToSigner: funtypes.Union(funtypes.ReadonlyObject({
		signerName: SignerName,
		connectionName: EthereumQuantity,
		ownerGeneration: funtypes.Number,
		signerProviderGeneration: funtypes.Number,
	}), funtypes.Undefined),
	forwardingStatus: funtypes.Union(WatchAssetForwardingStatus, funtypes.Undefined),
})
export type StoredWatchAssetRequest = WatchAssetRequestDetails & { readonly popupOrTabId: PopupOrTabId | undefined }
export const StoredWatchAssetRequest: funtypes.Codec<StoredWatchAssetRequest> = WatchAssetRequestDetails.And(funtypes.ReadonlyObject({
	popupOrTabId: funtypes.Union(PopupOrTabId, funtypes.Undefined),
}))
export type PendingWatchAssetRequest = WatchAssetRequestDetails & { readonly popupOrTabId: PopupOrTabId }
export const PendingWatchAssetRequest: funtypes.Codec<PendingWatchAssetRequest> = WatchAssetRequestDetails.And(funtypes.ReadonlyObject({
	popupOrTabId: PopupOrTabId,
}))

export type PendingFetchSimulationStackRequestPromise = funtypes.Static<typeof PendingFetchSimulationStackRequestPromise>
export const PendingFetchSimulationStackRequestPromise = funtypes.ReadonlyObject({
	website: Website,
	popupOrTabId: PopupOrTabId,
	simulationStackVersion: SimulationStackVersion,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
})
