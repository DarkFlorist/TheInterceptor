import { StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAccountsReply, EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from './visualizer-types.js'
import { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { CHAINS } from './constants.js'
import { SignerName } from './interceptor-messages.js'
import { WebsiteAccess } from '../background/settings.js'

export type CHAIN = keyof typeof CHAINS
export const CHAIN = funtypes.Union(funtypes.Literal('1'), funtypes.Literal('5'))

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

export type AddressBookEntry = funtypes.Static<typeof AddressBookEntry>
export const AddressBookEntry = funtypes.Union(
	AddressInfoEntry,
	funtypes.Object({
		type: funtypes.Literal('contact'),
		name: funtypes.String,
		address: EthereumAddress,
	}).And(funtypes.Partial({
		logoUri: funtypes.String,
	})),
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

export enum Page {
	Home,
	AddressList,
	AddNewAddress,
	ChangeActiveAddress,
	AccessList,
	NotificationCenter,
	ModifyAddress,
}

export type AddressListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setAddressInfos: StateUpdater<readonly AddressInfo[]>,
	addressInfos: readonly AddressInfo[],
}

export type InterceptorAccessListParams = {
	setAndSaveAppPage: (page: Page) => void,
	setWebsiteAccess: StateUpdater<readonly WebsiteAccess[] | undefined>,
	websiteAccess: readonly WebsiteAccess[] | undefined,
	websiteAccessAddressMetadata: [string, AddressInfoEntry][],
	renameAddressCallBack: RenameAddressCallBack,
}

export type AddAddressParam = {
	close: () => void,
	addressBookEntry: AddressBookEntry | undefined,
	setAddressBookEntryInput: (entry: AddressBookEntry) => void,
	setActiveAddressAndInformAboutIt: ((address: bigint | 'signer') => void) | undefined,
	addingNewAddress: boolean,
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
	tabConnection: TabConnection,
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
	tabConnection: TabConnection,
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
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type WebsiteApproval = {
	origin: string,
	approved: boolean, // if user has approved connection
}

export type TabConnection = {
	icon: string,
	iconReason: string,
}

export type NotificationCenterParams = {
	setAndSaveAppPage: (page: Page) => void,
	renameAddressCallBack: RenameAddressCallBack,
}

export type PendingAccessRequest = {
	origin: string,
	icon: string | undefined,
	requestAccessToAddress: string | undefined,
}

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, AddressInfoEntry][],
}

export interface SignerState {
	signerAccounts: EthereumAccountsReply | undefined,
	signerChain: EthereumQuantity | undefined
}

export type RenameAddressCallBack = (addressBookEntry: AddressBookEntry) => void
