import { StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAccountsReply, EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from './visualizer-types.js'
import { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { CHAINS } from './constants.js'
import { Page, SignerName, TabIconDetails, WebsiteAccessArray } from './interceptor-messages.js'

export type Website = funtypes.Static<typeof Website>
export const Website = funtypes.Object({
	websiteOrigin: funtypes.String,
	icon: funtypes.Union(funtypes.String, funtypes.Undefined),
	title: funtypes.Union(funtypes.String, funtypes.Undefined),
})

export type CHAIN = keyof typeof CHAINS
export const CHAIN = funtypes.Union(funtypes.Literal('1'), funtypes.Literal('5'), funtypes.Literal('11155111'))

export type AddressInfo = funtypes.Static<typeof AddressInfo>
export const AddressInfo = funtypes.Object({
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
}).asReadonly()

export type AddressInfoEntry = funtypes.Static<typeof AddressInfoEntry>
export const AddressInfoEntry = funtypes.Object({
	type: funtypes.Literal('addressInfo'),
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
})

export type TokenEntry = funtypes.Static<typeof TokenEntry>
export const TokenEntry = funtypes.Object({
	type: funtypes.Literal('token'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type NFTEntry = funtypes.Static<typeof NFTEntry>
export const NFTEntry = funtypes.Object({
	type: funtypes.Literal('NFT'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type ContactEntry = funtypes.Static<typeof ContactEntry>
export const ContactEntry = funtypes.Object({
	type: funtypes.Literal('contact'),
	name: funtypes.String,
	address: EthereumAddress,
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type ContactEntries = funtypes.Static<typeof ContactEntries>
export const ContactEntries = funtypes.ReadonlyArray(ContactEntry)

export type AddressBookEntryCategory = 'contact' | 'addressInfo' | 'token' | 'NFT' | 'other contract'

export type AddressBookEntry = funtypes.Static<typeof AddressBookEntry>
export const AddressBookEntry = funtypes.Union(
	AddressInfoEntry,
	ContactEntry,
	TokenEntry,
	NFTEntry,
	funtypes.Object({
		type: funtypes.Literal('other contract'),
		name: funtypes.String,
		address: EthereumAddress,
	}).And(funtypes.Partial({
		protocol: funtypes.String,
		logoUri: funtypes.String,
	}))
)

export type AddressBookEntries = funtypes.Static<typeof AddressBookEntries>
export const AddressBookEntries = funtypes.ReadonlyArray(AddressBookEntry)

export type AddressListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setAddressInfos: StateUpdater<readonly AddressInfo[]>,
	addressInfos: readonly AddressInfo[],
}

export type InterceptorAccessListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setWebsiteAccess: StateUpdater<WebsiteAccessArray | undefined>,
	websiteAccess: WebsiteAccessArray | undefined,
	websiteAccessAddressMetadata: readonly AddressInfoEntry[],
	renameAddressCallBack: RenameAddressCallBack,
}

export type AddingNewAddressType = {
	addingAddress: true,
	type: 'contact' | 'addressInfo' | 'token' | 'NFT' | 'other contract'
} | {
	addingAddress: false,
	entry: AddressBookEntry,
}

export type AddAddressParam = {
	close: () => void,
	setActiveAddressAndInformAboutIt: ((address: bigint | 'signer') => void) | undefined,
	addingNewAddress: AddingNewAddressType,
	activeAddress: bigint | undefined,
}

export type HomeParams = {
	setAndSaveAppPage: (page: Page) => void,
	makeMeRich: boolean,
	addressInfos: readonly AddressInfo[],
	signerAccounts: readonly bigint[] | undefined,
	activeSimulationAddress: bigint | undefined,
	activeSigningAddress: bigint | undefined,
	useSignersAddressAsActiveAddress: boolean,
	simVisResults: SimulationAndVisualisationResults | undefined,
	activeChain: bigint,
	setActiveChainAndInformAboutIt: (network: bigint) => void,
	simulationMode: boolean,
	tabIconDetails: TabIconDetails,
	tabApproved: boolean,
	currentBlockNumber: bigint | undefined,
	signerName: SignerName | undefined,
	renameAddressCallBack: RenameAddressCallBack,
}

export type ChangeActiveAddressParam = {
	addressInfos: readonly AddressInfo[]
	setAndSaveAppPage: (page: Page) => void,
	setActiveAddressAndInformAboutIt: (address: bigint | 'signer') => void,
	signerAccounts: readonly bigint[] | undefined,
	signerName: SignerName | undefined,
	renameAddressCallBack: RenameAddressCallBack,
}

export type FirstCardParams = {
	activeAddress: AddressInfo | undefined,
	enableSimulationMode: (x: boolean) => void,
	useSignersAddressAsActiveAddress: boolean,
	addressInfos: readonly AddressInfo[] | undefined,
	changeActiveChain: (chain: bigint) => void,
	activeChain: bigint,
	simulationMode: boolean,
	changeActiveAddress: () => void,
	makeMeRich: boolean,
	signerAccounts: readonly bigint[] | undefined,
	tabIconDetails: TabIconDetails,
	tabApproved: boolean,
	signerName: SignerName | undefined,
	renameAddressCallBack: RenameAddressCallBack,
}

export type SimulationStateParam = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults | undefined,
	removeTransaction: (hash: bigint) => void,
	refreshSimulation: () => void,
	currentBlockNumber: bigint | undefined,
	renameAddressCallBack: RenameAddressCallBack,
	refreshPressed: boolean,
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type WebsiteApproval = {
	websiteOrigin: string,
	approved: boolean, // if user has approved connection
}

export type NotificationCenterParams = {
	setAndSaveAppPage: (page: Page) => void
	renameAddressCallBack: RenameAddressCallBack
	pendingAccessRequests: PendingAccessRequestArray | undefined
	pendingAccessMetadata: readonly [string, AddressInfoEntry][]
}

export type PendingAccessRequest = funtypes.Static<typeof PendingAccessRequest>
export const PendingAccessRequest = funtypes.Object({
	website: Website,
	requestAccessToAddress: funtypes.Union(EthereumAddress, funtypes.Undefined),
}).asReadonly()

export type PendingAccessRequestArray = funtypes.Static<typeof PendingAccessRequestArray>
export const PendingAccessRequestArray = funtypes.ReadonlyArray(PendingAccessRequest)

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, AddressInfoEntry][],
}

export interface SignerState {
	signerAccounts: EthereumAccountsReply | undefined,
	signerChain: EthereumQuantity | undefined
}

export type RenameAddressCallBack = (addressBookEntry: AddressBookEntry) => void

export type TabConnection = {
	tabIconDetails: TabIconDetails
	portConnections: Record<string, browser.runtime.Port>
}
