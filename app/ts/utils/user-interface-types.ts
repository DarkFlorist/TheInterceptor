import { StateUpdater } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, RpcEntry, RpcNetwork, RpcEntries, SimulationUpdatingState, SimulationResultState } from './visualizer-types.js'
import { IdentifiedSwapWithMetadata } from '../components/simulationExplaining/SwapTransactions.js'
import { RpcConnectionStatus, Page, TabIconDetails, WebsiteAccessArray } from './interceptor-messages.js'

export type SignerName = funtypes.Static<typeof SignerName>
export const SignerName = funtypes.Union(
	funtypes.Literal('NoSigner'),
	funtypes.Literal('NotRecognizedSigner'),
	funtypes.Literal('MetaMask'),
	funtypes.Literal('Brave'),
	funtypes.Literal('CoinbaseWallet'),
	funtypes.Literal('NoSignerDetected'),
)

export type WebsiteSocket = funtypes.Static<typeof WebsiteSocket>
export const WebsiteSocket = funtypes.ReadonlyObject({
	tabId: funtypes.Number,
	connectionName: EthereumQuantity,
})

export type Website = funtypes.Static<typeof Website>
export const Website = funtypes.ReadonlyObject({
	websiteOrigin: funtypes.String,
	icon: funtypes.Union(funtypes.String, funtypes.Undefined),
	title: funtypes.Union(funtypes.String, funtypes.Undefined),
})

export type AddressInfo = funtypes.Static<typeof AddressInfo>
export const AddressInfo = funtypes.ReadonlyObject({
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
}).asReadonly()

export type AddressInfoArray = funtypes.Static<typeof AddressInfoArray>
export const AddressInfoArray = funtypes.ReadonlyArray(AddressInfo)

export type AddressInfoEntry = funtypes.Static<typeof AddressInfoEntry>
export const AddressInfoEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('addressInfo'),
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
})

export type Erc20TokenEntry = funtypes.Static<typeof Erc20TokenEntry>
export const Erc20TokenEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC20'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type Erc721Entry = funtypes.Static<typeof Erc721Entry>
export const Erc721Entry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC721'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type Erc1155Entry = funtypes.Static<typeof Erc1155Entry>
export const Erc1155Entry = funtypes.ReadonlyObject({
	type: funtypes.Literal('ERC1155'),
	name: funtypes.String,
	address: EthereumAddress,
	symbol: funtypes.String,
	decimals: funtypes.Undefined,
}).And(funtypes.Partial({
	protocol: funtypes.String,
	logoUri: funtypes.String,
}))

export type ContactEntry = funtypes.Static<typeof ContactEntry>
export const ContactEntry = funtypes.ReadonlyObject({
	type: funtypes.Literal('contact'),
	name: funtypes.String,
	address: EthereumAddress,
}).And(funtypes.Partial({
	logoUri: funtypes.String,
}))

export type ContactEntries = funtypes.Static<typeof ContactEntries>
export const ContactEntries = funtypes.ReadonlyArray(ContactEntry)

export type AddressBookEntryCategory = 'contact' | 'addressInfo' | 'ERC20' | 'ERC721' | 'contract' | 'ERC1155'

export type AddressBookEntry = funtypes.Static<typeof AddressBookEntry>
export const AddressBookEntry = funtypes.Union(
	AddressInfoEntry,
	ContactEntry,
	Erc20TokenEntry,
	Erc721Entry,
	Erc1155Entry,
	funtypes.ReadonlyObject({
		type: funtypes.Literal('contract'),
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

export type InCompleteAddressBookEntry = {
	addingAddress: boolean, // if false, we are editing addess
	type: 'addressInfo' | 'contact' | 'contract' | 'ERC20' | 'ERC1155' | 'ERC721'
	address: string | undefined
	askForAddressAccess: boolean
	name: string | undefined
	symbol: string | undefined
	decimals: bigint | undefined
	logoUri: string | undefined
}

export type AddAddressParam = {
	close: () => void,
	setActiveAddressAndInformAboutIt: ((address: bigint | 'signer') => Promise<void>) | undefined,
	inCompleteAddressBookEntry: InCompleteAddressBookEntry,
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
	addressInfos: readonly AddressInfo[]
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
	activeAddress: AddressInfo | undefined,
	enableSimulationMode: (x: boolean) => void,
	useSignersAddressAsActiveAddress: boolean,
	addressInfos: readonly AddressInfo[] | undefined,
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
	simulationAndVisualisationResults: SimulationAndVisualisationResults | undefined,
	removeTransaction: (tx: SimulatedAndVisualizedTransaction) => void,
	currentBlockNumber: bigint | undefined,
	renameAddressCallBack: RenameAddressCallBack,
	disableReset: boolean,
	resetSimulation: () => void,
	removeTransactionHashes: bigint[],
	rpcConnectionStatus: RpcConnectionStatus,
	simulationUpdatingState: SimulationUpdatingState | undefined,
	simulationResultState: SimulationResultState | undefined,
}

export type LogAnalysisParams = {
	simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction,
	identifiedSwap: IdentifiedSwapWithMetadata,
	renameAddressCallBack: RenameAddressCallBack,
}

export type RenameAddressCallBack = (addressBookEntry: AddressBookEntry) => void

export type SocketConnection = {
	port: browser.runtime.Port,
	socket: WebsiteSocket,
	websiteOrigin: string,
	approved: boolean, // if user has approved connection
	wantsToConnect: boolean,
}

export type TabConnection = {
	connections: Record<string, SocketConnection> // socket as string
}

export type WebsiteTabConnections = Map<number, TabConnection>

export type WindowOrTabId = funtypes.Static<typeof WindowOrTabId>
export const WindowOrTabId = funtypes.ReadonlyObject({
	id: funtypes.Number,
	type: funtypes.Union(funtypes.Literal('tab'), funtypes.Literal('window'))
})
