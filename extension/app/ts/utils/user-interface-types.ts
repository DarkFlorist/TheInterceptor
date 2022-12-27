import { StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAccountsReply, EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'
import { AddressMetadata, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from './visualizer-types.js'
import { WebsiteAccess } from '../background/settings.js'
import { IdentifiedSwap } from '../components/simulationExplaining/SwapTransactions.js'
import { CHAINS } from './constants.js'
import { SignerName } from './interceptor-messages.js'

export type CHAIN = keyof typeof CHAINS
export const CHAIN = funtypes.Union(funtypes.Literal('1'), funtypes.Literal('5'))

export type AddressInfo = funtypes.Static<typeof AddressInfo>
export const AddressInfo = funtypes.Object({
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
}).asReadonly()

export enum Page {
	Home,
	AddressList,
	AddNewAddress,
	ChangeActiveAddress,
	AccessList,
	NotificationCenter,
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
	websiteAccessAddressMetadata: [string, AddressMetadata][],
}

export type AddAddressParam = {
	setAndSaveAppPage: (page: Page) => void,
	addressInfos: readonly AddressInfo[],
	setAddressInfos: StateUpdater<readonly AddressInfo[]>,
	addressInput: string | undefined,
	nameInput: string | undefined,
	setAddressInput: (address: string) => void,
	setNameInput: (name: string) => void,
	setActiveAddressAndInformAboutIt: (address: bigint | 'signer') => void,
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
}

export type ChangeActiveAddressParam = {
	addressInfos: readonly AddressInfo[]
	setAndSaveAppPage: (page: Page) => void,
	setActiveAddressAndInformAboutIt: (address: bigint | 'signer') => void,
	signerAccounts: readonly bigint[] | undefined,
	signerName: SignerName | undefined,
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
}

export type SimulationStateParam = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults | undefined,
	removeTransaction: (hash: bigint) => void,
	addressMetadata: Map<string, AddressMetadata>,
	refreshSimulation: () => void,
	currentBlockNumber: bigint | undefined,
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	addressMetadata: Map<string, AddressMetadata>,
	identifiedSwap: IdentifiedSwap,
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
}

export type PendingAccessRequest = {
	origin: string,
	icon: string | undefined,
	requestAccessToAddress: string | undefined,
}

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, AddressMetadata][],
}

export interface SignerState {
	signerAccounts: EthereumAccountsReply | undefined,
	signerChain: EthereumQuantity | undefined
}
