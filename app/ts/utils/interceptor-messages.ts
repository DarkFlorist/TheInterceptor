import * as funtypes from 'funtypes'
import { AddressBookEntries, AddressBookEntry, AddressInfo, AddressInfoEntry, ContactEntries, SignerName, Website, WebsiteSocket } from './user-interface-types.js'
import { EthGetLogsResponse, EthTransactionReceiptResponse, EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, EthereumTimestamp, GetBlockReturn, GetSimulationStackReply, OldSignTypedDataParams, PersonalSignParams, SendRawTransaction, SendTransactionParams, SignTypedDataParams } from './wire-types.js'
import { SimulationState, OptionalEthereumAddress, SimulatedAndVisualizedTransaction, SimResults, TokenPriceEstimate, WebsiteCreatedEthereumUnsignedTransaction, RpcNetwork, RpcEntries, RpcEntry } from './visualizer-types.js'
import { ICON_ACCESS_DENIED, ICON_ACTIVE, ICON_NOT_ACTIVE, ICON_SIGNING, ICON_SIGNING_NOT_SUPPORTED, ICON_SIMULATING } from './constants.js'
import { PersonalSignRequestData } from './personal-message-definitions.js'

export type WalletSwitchEthereumChainReply = funtypes.Static<typeof WalletSwitchEthereumChainReply>
export const WalletSwitchEthereumChainReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_switchEthereumChain_reply'),
	params: funtypes.Tuple(funtypes.ReadonlyObject({
		accept: funtypes.Boolean,
		chainId: EthereumQuantity,
	}))
}).asReadonly()

export type InterceptedRequest = funtypes.Static<typeof InterceptedRequest>
export const InterceptedRequest = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
		}).asReadonly(),
		funtypes.ReadonlyObject({ method: funtypes.String }).asReadonly()
	),
	funtypes.ReadonlyObject({
		interceptorRequest: funtypes.Boolean,
		usingInterceptorWithoutSigner: funtypes.Boolean,
		requestId: funtypes.Number,
	})
)
export type ProviderMessage = InterceptedRequest

export type InpageScriptRequest = funtypes.Static<typeof InpageScriptRequest>
export const InpageScriptRequest = funtypes.Intersect(
	funtypes.ReadonlyObject({ requestId: funtypes.Number }),
	funtypes.Union(
		funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts_reply'), result: funtypes.Literal('0x') }),
		funtypes.ReadonlyObject({ method: funtypes.Literal('signer_chainChanged'), result: funtypes.Literal('0x') }),
		funtypes.ReadonlyObject({ method: funtypes.Literal('connected_to_signer'), result: funtypes.Literal('0x') }),
		funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain_reply'), result: funtypes.Literal('0x') }),
	)
)

export type InpageScriptCallBack = funtypes.Static<typeof InpageScriptCallBack>
export const InpageScriptCallBack = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_chainId'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_wallet_switchEthereumChain'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_requestAccounts'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_accounts'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('disconnect'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('connect'), result: funtypes.ReadonlyTuple(EthereumQuantity) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('accountsChanged'), result: funtypes.ReadonlyArray(EthereumAddress) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('chainChanged'), result: EthereumQuantity }),
)

export type NonForwardingRPCRequestSuccessfullReturnValue = funtypes.Static<typeof NonForwardingRPCRequestSuccessfullReturnValue>
export const NonForwardingRPCRequestSuccessfullReturnValue = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByNumber'), result: GetBlockReturn }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBalance'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_estimateGas'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionByHash'), result: funtypes.Union(EthereumSignedTransactionWithBlockData, funtypes.Undefined) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionReceipt'), result: EthTransactionReceiptResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_subscribe'), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_unsubscribe'), result: funtypes.Boolean }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('net_version'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getCode'), result: EthereumData }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain'), result: funtypes.Null }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts'), result: funtypes.ReadonlyArray(EthereumAddress) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions'), result: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({}) })) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionCount'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('interceptor_getSimulationStack'), result: funtypes.ReadonlyObject({ version: funtypes.Literal('1.0.0'), payload: GetSimulationStackReply }) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getLogs'), result: EthGetLogsResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendRawTransaction'), result: EthereumBytes32 }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendTransaction'), result: EthereumBytes32 }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_call'), result: EthereumData }),
	funtypes.ReadonlyObject({ method: funtypes.Union(funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4'), funtypes.Literal('eth_signTypedData')), result: funtypes.String }),
)

export type ErrorReturn = funtypes.Static<typeof ErrorReturn>
export const ErrorReturn = funtypes.ReadonlyObject({
	method: funtypes.String,
	error: funtypes.Intersect(
		funtypes.ReadonlyObject({
			code: funtypes.Number,
			message: funtypes.String,
		}),
		funtypes.ReadonlyPartial({
			data: funtypes.String,
		})
	)
})

export type SubscriptionReturnValue = funtypes.Static<typeof SubscriptionReturnValue>
export const SubscriptionReturnValue = funtypes.ReadonlyObject({
	method: funtypes.Literal('newHeads'),
	result: funtypes.ReadonlyObject({
		subscription: funtypes.Literal('newHeads'),
		result: EthereumBlockHeaderWithTransactionHashes
	})
})

export type NonForwardingRPCRequestReturnValue = funtypes.Static<typeof NonForwardingRPCRequestReturnValue>
export const NonForwardingRPCRequestReturnValue = funtypes.Union(NonForwardingRPCRequestSuccessfullReturnValue, ErrorReturn)

export type ForwardToWallet = funtypes.Static<typeof ForwardToWallet>
export const ForwardToWallet = 	funtypes.Intersect( // forward directly to wallet
	funtypes.ReadonlyObject({ forward: funtypes.Literal(true) }),
	funtypes.Union(SendRawTransaction, SendTransactionParams, PersonalSignParams, SignTypedDataParams, OldSignTypedDataParams),
)

export type RPCReply = funtypes.Static<typeof RPCReply>
export const RPCReply = funtypes.Union(
	NonForwardingRPCRequestReturnValue,
	ForwardToWallet,
)

export type RPCReplyWithRequestId = funtypes.Static<typeof RPCReply>
export const RPCReplyWithRequestId = funtypes.Intersect(
	funtypes.ReadonlyObject({ requestId: funtypes.Number }),
	RPCReply,
)

export type InterceptedRequestForward = funtypes.Static<typeof InterceptedRequestForward>
export const InterceptedRequestForward = funtypes.Union(
	RPCReplyWithRequestId,
	funtypes.Intersect( // subscriptions
		funtypes.ReadonlyObject({
			method: funtypes.String,
			subscription: funtypes.String,
		}),
		SubscriptionReturnValue,
	),
	InpageScriptRequest,
	InpageScriptCallBack, // send callback
)

export type InterceptorMessageToInpage = funtypes.Static<typeof InterceptorMessageToInpage>
export const InterceptorMessageToInpage = funtypes.Intersect(
	funtypes.ReadonlyObject({ interceptorApproved: funtypes.Literal(true) }),
	InterceptedRequestForward,
)

export type TransactionConfirmation = funtypes.Static<typeof TransactionConfirmation>
export const TransactionConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_confirmDialog'),
	data: funtypes.ReadonlyObject({
		requestId: funtypes.Number,
		accept: funtypes.Boolean,
		windowId: funtypes.Number,
	})
}).asReadonly()

export type PersonalSign = funtypes.Static<typeof PersonalSign>
export const PersonalSign = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_personalSign'),
	data: funtypes.ReadonlyObject({
		requestId: funtypes.Number,
		accept: funtypes.Boolean
	})
}).asReadonly()

export type InterceptorAccessRefresh = funtypes.Static<typeof InterceptorAccessRefresh>
export const InterceptorAccessRefresh = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccessRefresh'),
	data: funtypes.ReadonlyObject({
		socket: WebsiteSocket,
		website: Website,
		requestAccessToAddress: OptionalEthereumAddress,
		accessRequestId: funtypes.String,
	}),
}).asReadonly()

export type RefreshInterceptorAccessMetadata = funtypes.Static<typeof RefreshInterceptorAccessMetadata>
export const RefreshInterceptorAccessMetadata = funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshInterceptorAccessMetadata') }).asReadonly()

export type InterceptorAccessChangeAddress = funtypes.Static<typeof InterceptorAccessChangeAddress>
export const InterceptorAccessChangeAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccessChangeAddress'),
	data: funtypes.ReadonlyObject({
		socket: WebsiteSocket,
		website: Website,
		requestAccessToAddress: OptionalEthereumAddress,
		newActiveAddress: funtypes.Union(EthereumAddress, funtypes.Literal('signer')),
		accessRequestId: funtypes.String,
	}),
}).asReadonly()

export type ChangeActiveAddress = funtypes.Static<typeof ChangeActiveAddress>
export const ChangeActiveAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeActiveAddress'),
	data: funtypes.ReadonlyObject({
		simulationMode: funtypes.Boolean,
		activeAddress: funtypes.Union(EthereumAddress, funtypes.Literal('signer'))
	})
}).asReadonly()

export type ChangeMakeMeRich = funtypes.Static<typeof ChangeMakeMeRich>
export const ChangeMakeMeRich = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeMakeMeRich'),
	data: funtypes.Boolean
}).asReadonly()

export type AddressBookCategory = funtypes.Static<typeof AddressBookCategory>
export const AddressBookCategory = funtypes.Union(
	funtypes.Literal('My Active Addresses'),
	funtypes.Literal('My Contacts'),
	funtypes.Literal('Tokens'),
	funtypes.Literal('Non Fungible Tokens'),
	funtypes.Literal('Other Contracts')
)

export type RemoveAddressBookEntry = funtypes.Static<typeof RemoveAddressBookEntry>
export const RemoveAddressBookEntry = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeAddressBookEntry'),
	data: funtypes.ReadonlyObject({
		address: EthereumAddress,
		addressBookCategory: AddressBookCategory,
	})
}).asReadonly()

export type AddOrEditAddressBookEntry = funtypes.Static<typeof AddOrEditAddressBookEntry>
export const AddOrEditAddressBookEntry = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_addOrModifyAddressBookEntry'),
	data: AddressBookEntry,
}).asReadonly()

export const pages = ['Home', 'AddNewAddress', 'ChangeActiveAddress', 'AccessList', 'ModifyAddress']
export type Page = funtypes.Static<typeof Page>
export const Page = funtypes.Union(
	funtypes.Literal('Home'),
	funtypes.Literal('AddNewAddress'),
	funtypes.Literal('ChangeActiveAddress'),
	funtypes.Literal('AccessList'),
	funtypes.Literal('ModifyAddress'),
	funtypes.Literal('Settings'),
)

export type ChangePage = funtypes.Static<typeof ChangePage>
export const ChangePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changePage'),
	data: Page,
}).asReadonly()

export type RequestAccountsFromSigner = funtypes.Static<typeof RequestAccountsFromSigner>
export const RequestAccountsFromSigner = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestAccountsFromSigner'),
	data: funtypes.Boolean
}).asReadonly()

export type EnableSimulationMode = funtypes.Static<typeof EnableSimulationMode>
export const EnableSimulationMode = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_enableSimulationMode'),
	data: funtypes.Boolean
}).asReadonly()

export type RemoveTransaction = funtypes.Static<typeof RemoveTransaction>
export const RemoveTransaction = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeTransaction'),
	data: EthereumQuantity,
}).asReadonly()

export type ResetSimulation = funtypes.Static<typeof ResetSimulation>
export const ResetSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_resetSimulation')
}).asReadonly()

export type RefreshSimulation = funtypes.Static<typeof RefreshSimulation>
export const RefreshSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshSimulation')
}).asReadonly()

export type ChangeInterceptorAccess = funtypes.Static<typeof ChangeInterceptorAccess>
export const ChangeInterceptorAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeInterceptorAccess'),
	data: funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			website: Website,
			access: funtypes.Boolean,
			addressAccess: funtypes.Union(
				funtypes.ReadonlyArray(funtypes.ReadonlyObject( {
					address: EthereumAddress,
					access: funtypes.Boolean,
				} ))
			, funtypes.Undefined),
		})
	)
}).asReadonly()

export type SignerChainChangeConfirmation = funtypes.Static<typeof SignerChainChangeConfirmation>
export const SignerChainChangeConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_signerChangeChainDialog'),
	data: funtypes.ReadonlyObject({
		chainId: EthereumQuantity,
		accept: funtypes.Boolean,
	})
}).asReadonly()

export type ConnectedToSigner = funtypes.Static<typeof ConnectedToSigner>
export const ConnectedToSigner = funtypes.ReadonlyObject({
	method: funtypes.Literal('connected_to_signer'),
	params: funtypes.Tuple(SignerName),
}).asReadonly()

export type GetAddressBookDataFilter = funtypes.Static<typeof GetAddressBookDataFilter>
export const GetAddressBookDataFilter = funtypes.Intersect(
	funtypes.ReadonlyObject({
		filter: AddressBookCategory,
		startIndex: funtypes.Number,
		maxIndex: funtypes.Number,
	}).asReadonly(),
	funtypes.Partial({
		searchString: funtypes.String,
	}).asReadonly()
)

export type GetAddressBookData = funtypes.Static<typeof GetAddressBookData>
export const GetAddressBookData = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_getAddressBookData'),
	data: GetAddressBookDataFilter,
}).asReadonly()

export type OpenAddressBook = funtypes.Static<typeof OpenAddressBook>
export const OpenAddressBook = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_openAddressBook'),
}).asReadonly()

export type GetAddressBookDataReplyData = funtypes.Static<typeof GetAddressBookDataReplyData>
export const GetAddressBookDataReplyData = funtypes.ReadonlyObject({
	data: GetAddressBookDataFilter,
	entries: AddressBookEntries,
	maxDataLength: funtypes.Number,
}).asReadonly()

export type GetAddressBookDataReply = funtypes.Static<typeof GetAddressBookDataReply>
export const GetAddressBookDataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_getAddressBookDataReply'),
	data: GetAddressBookDataReplyData,
}).asReadonly()

export type RefreshConfirmTransactionDialogSimulation = funtypes.Static<typeof RefreshConfirmTransactionDialogSimulation>
export const RefreshConfirmTransactionDialogSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshConfirmTransactionDialogSimulation'),
	data: funtypes.ReadonlyObject({
		activeAddress: EthereumAddress,
		simulationMode: funtypes.Boolean,
		requestId: funtypes.Number,
		transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
		tabIdOpenedFrom: funtypes.Number,
	}),
}).asReadonly()

export type RpcConnectionStatus = funtypes.Static<typeof RpcConnectionStatus>
export const RpcConnectionStatus = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	isConnected: funtypes.Boolean,
	lastConnnectionAttempt: EthereumTimestamp,
	rpcNetwork: RpcNetwork,
	latestBlock: funtypes.Union(funtypes.Undefined, EthereumBlockHeader),
}))

export type NewBlockArrivedOrFailedToArrive = funtypes.Static<typeof NewBlockArrivedOrFailedToArrive>
export const NewBlockArrivedOrFailedToArrive = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_new_block_arrived'), funtypes.Literal('popup_failed_to_get_block')),
	data: funtypes.ReadonlyObject({ rpcConnectionStatus: RpcConnectionStatus }),
}).asReadonly()

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

export type WebsiteIconChanged = funtypes.Static<typeof WebsiteIconChanged>
export const WebsiteIconChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_websiteIconChanged'),
	data: TabIconDetails
})

export type MessageToPopupSimple = funtypes.Static<typeof MessageToPopupSimple>
export const MessageToPopupSimple = funtypes.ReadonlyObject({
	method: funtypes.Union(
		funtypes.Literal('popup_chain_update'),
		funtypes.Literal('popup_started_simulation_update'),
		funtypes.Literal('popup_simulation_state_changed'),
		funtypes.Literal('popup_confirm_transaction_simulation_started'),
		funtypes.Literal('popup_accounts_update'),
		funtypes.Literal('popup_addressBookEntriesChanged'),
		funtypes.Literal('popup_interceptor_access_changed'),
		funtypes.Literal('popup_notification_removed'),
		funtypes.Literal('popup_signer_name_changed'),
		funtypes.Literal('popup_websiteAccess_changed'),
	)
}).asReadonly()

export type PersonalSignRequest = funtypes.Static<typeof PersonalSignRequest>
export const PersonalSignRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_personal_sign_request'),
	data: PersonalSignRequestData,
})

export type RefreshPersonalSignMetadata = funtypes.Static<typeof RefreshPersonalSignMetadata>
export const RefreshPersonalSignMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshPersonalSignMetadata'),
	data: PersonalSignRequestData,
})

export type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
export const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	requestId: funtypes.Number,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
	signerName: SignerName,
	tabIdOpenedFrom: funtypes.Number,
})

export type ConfirmTransactionDialogState = funtypes.Static<typeof ConfirmTransactionDialogState>
export const ConfirmTransactionDialogState = funtypes.Intersect(ConfirmTransactionSimulationBaseData, funtypes.ReadonlyObject({
	simulationState: SimulationState,
	visualizerResults: funtypes.ReadonlyArray(SimResults),
	addressBookEntries: AddressBookEntries,
	tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
	simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
}))

export type ConfirmTransactionSimulationStateChanged = funtypes.Static<typeof ConfirmTransactionSimulationStateChanged>
export const ConfirmTransactionSimulationStateChanged = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('success'),
	data: ConfirmTransactionDialogState
})

export type RefreshConfirmTransactionMetadata = funtypes.Static<typeof RefreshConfirmTransactionMetadata>
export const RefreshConfirmTransactionMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshConfirmTransactionMetadata'),
	data: ConfirmTransactionDialogState
}).asReadonly()

export type ConfirmTransactionSimulationFailed = funtypes.Static<typeof ConfirmTransactionSimulationFailed>
export const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('failed'),
	data: ConfirmTransactionSimulationBaseData,
}).asReadonly()

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged)

export type ConfirmTransactionTransactionSingleVisualizationArray = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualizationArray>
export const ConfirmTransactionTransactionSingleVisualizationArray = funtypes.ReadonlyArray(ConfirmTransactionTransactionSingleVisualization)

export type UpdateConfirmTransactionDialog = funtypes.Static<typeof UpdateConfirmTransactionDialog>
export const UpdateConfirmTransactionDialog = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
	data: ConfirmTransactionTransactionSingleVisualizationArray,
}).asReadonly()

export type ConfirmTransactionDialogPendingChanged = funtypes.Static<typeof ConfirmTransactionDialogPendingChanged>
export const ConfirmTransactionDialogPendingChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_confirm_transaction_dialog_pending_changed'),
	data: ConfirmTransactionTransactionSingleVisualizationArray,
}).asReadonly()

export type WebsiteAddressAccess = funtypes.Static<typeof WebsiteAddressAccess>
export const WebsiteAddressAccess = funtypes.ReadonlyObject({
	address: EthereumAddress,
	access: funtypes.Boolean,
}).asReadonly()

export type LegacyWebsiteAccess = funtypes.Static<typeof WebsiteAccess>
export const LegacyWebsiteAccess = funtypes.ReadonlyObject({
	origin: funtypes.String,
	originIcon: funtypes.Union(funtypes.String, funtypes.Undefined),
	access: funtypes.Boolean,
	addressAccess: funtypes.Union(funtypes.ReadonlyArray(WebsiteAddressAccess), funtypes.Undefined),
})
export type LegacyWebsiteAccessArray = funtypes.Static<typeof LegacyWebsiteAccessArray>
export const LegacyWebsiteAccessArray = funtypes.ReadonlyArray(LegacyWebsiteAccess)

export type WebsiteAccess = funtypes.Static<typeof WebsiteAccess>
export const WebsiteAccess = funtypes.ReadonlyObject({
	website: Website,
	access: funtypes.Boolean,
	addressAccess: funtypes.Union(funtypes.ReadonlyArray(WebsiteAddressAccess), funtypes.Undefined),
}).asReadonly()

export type WebsiteAccessArray = funtypes.Static<typeof WebsiteAccessArray>
export const WebsiteAccessArray = funtypes.ReadonlyArray(WebsiteAccess)

export type WebsiteAccessArrayWithLegacy = funtypes.Static<typeof WebsiteAccessArrayWithLegacy>
export const WebsiteAccessArrayWithLegacy = funtypes.Union(LegacyWebsiteAccessArray, WebsiteAccessArray)

export type UserAddressBook = funtypes.Static<typeof UserAddressBook>
export const UserAddressBook = funtypes.ReadonlyObject({
	addressInfos: funtypes.ReadonlyArray(AddressInfo),
	contacts: ContactEntries,
})

export type PendingAccessRequest = funtypes.Static<typeof PendingAccessRequest>
export const PendingAccessRequest = funtypes.ReadonlyObject({
	website: Website,
	requestAccessToAddress: funtypes.Union(AddressInfoEntry, funtypes.Undefined),
	originalRequestAccessToAddress: funtypes.Union(AddressInfoEntry, funtypes.Undefined),
	associatedAddresses: funtypes.ReadonlyArray(AddressInfoEntry),
	addressInfos: funtypes.ReadonlyArray(AddressInfo),
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
	signerName: SignerName,
	simulationMode: funtypes.Boolean,
	socket: WebsiteSocket,
	dialogId: funtypes.Number,
	request: funtypes.Union(InterceptedRequest, funtypes.Undefined),
	accessRequestId: funtypes.String,
	activeAddress: OptionalEthereumAddress,
}).asReadonly()

export type InterceptorAccessReply = funtypes.Static<typeof InterceptorAccessReply>
export const InterceptorAccessReply = funtypes.ReadonlyObject({
	accessRequestId: funtypes.String,
	originalRequestAccessToAddress: OptionalEthereumAddress,
	requestAccessToAddress: OptionalEthereumAddress,
	userReply: funtypes.Union(funtypes.Literal('Approved'), funtypes.Literal('Rejected'), funtypes.Literal('NoResponse') ),
})

export type InterceptorAccess = funtypes.Static<typeof InterceptorAccess>
export const InterceptorAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccess'),
	data: InterceptorAccessReply,
}).asReadonly()

export type PendingAccessRequestArray = funtypes.Static<typeof PendingAccessRequestArray>
export const PendingAccessRequestArray = funtypes.ReadonlyArray(PendingAccessRequest)

export type InterceptorAccessDialog = funtypes.Static<typeof InterceptorAccessDialog>
export const InterceptorAccessDialog = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_interceptorAccessDialog'), funtypes.Literal('popup_interceptor_access_dialog_pending_changed')),
	data: PendingAccessRequestArray
})

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, AddressInfoEntry][],
}

export type Settings = funtypes.Static<typeof Settings>
export const Settings = funtypes.ReadonlyObject({
	activeSimulationAddress: OptionalEthereumAddress,
	rpcNetwork: RpcNetwork,
	page: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
	userAddressBook: UserAddressBook,
})

export type UpdateHomePage = funtypes.Static<typeof UpdateHomePage>
export const UpdateHomePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UpdateHomePage'),
	data: funtypes.ReadonlyObject({
		simulation: funtypes.ReadonlyObject({
			simulationState: funtypes.Union(SimulationState, funtypes.Undefined),
			visualizerResults: funtypes.Union(funtypes.ReadonlyArray(SimResults), funtypes.Undefined),
			addressBookEntries: AddressBookEntries,
			tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
			activeAddress: OptionalEthereumAddress,
			simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
		}),
		websiteAccessAddressMetadata: funtypes.ReadonlyArray(AddressInfoEntry),
		signerAccounts: funtypes.Union(funtypes.ReadonlyArray(EthereumAddress), funtypes.Undefined),
		signerChain: funtypes.Union(EthereumQuantity, funtypes.Undefined),
		signerName: SignerName,
		currentBlockNumber: funtypes.Union(EthereumQuantity, funtypes.Undefined),
		settings: Settings,
		tabIconDetails: funtypes.Union(TabIconDetails, funtypes.Undefined),
		makeMeRich: funtypes.Boolean,
		rpcConnectionStatus: RpcConnectionStatus,
		useTabsInsteadOfPopup: funtypes.Boolean,
		activeSigningAddressInThisTab: OptionalEthereumAddress,
		tabId: funtypes.Union(funtypes.Number, funtypes.Undefined),
		rpcEntries: RpcEntries,
	})
})

export type ActiveSigningAddressChanged = funtypes.Static<typeof ActiveSigningAddressChanged>
export const ActiveSigningAddressChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_activeSigningAddressChanged'),
	data: funtypes.ReadonlyObject({
		tabId: funtypes.Number,
		activeSigningAddress: OptionalEthereumAddress,
	})
})

export type WindowMessageSignerAccountsChanged = funtypes.Static<typeof WindowMessageSignerAccountsChanged>
export const WindowMessageSignerAccountsChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('window_signer_accounts_changed'),
	data: funtypes.ReadonlyObject({
		socket: WebsiteSocket,
	})
})

export type WindowMessage = funtypes.Static<typeof WindowMessage>
export const WindowMessage = WindowMessageSignerAccountsChanged

export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = funtypes.ReadonlyObject({
	dialogId: funtypes.Number,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	transactionParams: funtypes.Union(SendTransactionParams, SendRawTransaction),
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
	simulationMode: funtypes.Boolean,
	activeAddress: EthereumAddress,
	simulationResults: ConfirmTransactionTransactionSingleVisualization
})

export type PendingChainChangeConfirmationPromise = funtypes.Static<typeof PendingChainChangeConfirmationPromise>
export const PendingChainChangeConfirmationPromise = funtypes.ReadonlyObject({
	website: Website,
	dialogId: funtypes.Number,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	rpcNetwork: RpcNetwork,
	simulationMode: funtypes.Boolean,
})

export type PendingPersonalSignPromise = funtypes.Static<typeof PendingPersonalSignPromise>
export const PendingPersonalSignPromise = funtypes.ReadonlyObject({
	website: Website,
	dialogId: funtypes.Number,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	simulationMode: funtypes.Boolean,
	params: funtypes.Union(PersonalSignParams, SignTypedDataParams, OldSignTypedDataParams),
	activeAddress: EthereumAddress,
})

export type TabState = funtypes.Static<typeof TabState>
export const TabState = funtypes.ReadonlyObject({
	signerName: SignerName,
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
	signerChain: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	tabIconDetails: TabIconDetails,
	activeSigningAddress: OptionalEthereumAddress,
})

export type ChangeSettings = funtypes.Static<typeof ChangeSettings>
export const ChangeSettings = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_ChangeSettings'),
	data: funtypes.ReadonlyObject({
		useTabsInsteadOfPopup: funtypes.Union(funtypes.Boolean, funtypes.Undefined),
	})
})

export type ImportSettings = funtypes.Static<typeof ImportSettings>
export const ImportSettings = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_import_settings'),
	data: funtypes.ReadonlyObject({ fileContents: funtypes.String })
})

export type ImportSettingsReply = funtypes.Static<typeof ImportSettingsReply>
export const ImportSettingsReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_initiate_export_settings_reply'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({ success: funtypes.Literal(true) }),
		funtypes.ReadonlyObject({ success: funtypes.Literal(false), errorMessage: funtypes.String })
	)
})

export type SetRpcList = funtypes.Static<typeof SetRpcList>
export const SetRpcList = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_set_rpc_list')),
	data: RpcEntries,
})

export type UpdateRPCList = funtypes.Static<typeof UpdateRPCList>
export const UpdateRPCList = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_update_rpc_list')),
	data: RpcEntries,
})

export type ChangeActiveChain = funtypes.Static<typeof ChangeActiveChain>
export const ChangeActiveChain = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeActiveRpc'),
	data: RpcEntry,
}).asReadonly()

export type ChainChangeConfirmation = funtypes.Static<typeof ChainChangeConfirmation>
export const ChainChangeConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeChainDialog'),
	data: funtypes.ReadonlyObject({
		rpcNetwork: RpcNetwork,
		requestId: funtypes.Number,
		accept: funtypes.Boolean,
	}),	
}).asReadonly()

export type ChangeChainRequest = funtypes.Static<typeof ChangeChainRequest>
export const ChangeChainRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_ChangeChainRequest'),
	data: PendingChainChangeConfirmationPromise,
})

export type SettingsUpdated = funtypes.Static<typeof SettingsUpdated>
export const SettingsUpdated = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_settingsUpdated'),
	data: Settings
})

export type PopupMessage = funtypes.Static<typeof PopupMessage>
export const PopupMessage = funtypes.Union(
	ChangeMakeMeRich,
	ChangeActiveAddress,
	TransactionConfirmation,
	ChangePage,
	RequestAccountsFromSigner,
	RemoveTransaction,
	ResetSimulation,
	RefreshSimulation,
	RefreshConfirmTransactionDialogSimulation,
	RefreshConfirmTransactionMetadata,
	PersonalSign,
	InterceptorAccess,
	InterceptorAccessRefresh,
	InterceptorAccessChangeAddress,
	RefreshInterceptorAccessMetadata,
	ChangeInterceptorAccess,
	ChangeActiveChain,
	ChainChangeConfirmation,
	EnableSimulationMode,
	AddOrEditAddressBookEntry,
	GetAddressBookData,
	RemoveAddressBookEntry,
	OpenAddressBook,
	RefreshPersonalSignMetadata,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_personalSignReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_changeChainReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_interceptorAccessReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_confirmTransactionReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestNewHomeData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_import_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_get_export_settings') }),
	ChangeSettings,
	SetRpcList,
)

export type MessageToPopup = funtypes.Static<typeof MessageToPopup>
export const MessageToPopup = funtypes.Union(
	MessageToPopupSimple,
	WebsiteIconChanged,
	GetAddressBookDataReply,
	PersonalSignRequest,
	ChangeChainRequest,
	InterceptorAccessDialog,
	NewBlockArrivedOrFailedToArrive,
	UpdateHomePage,
	SettingsUpdated,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_failed_to_update_simulation_state') }),
	UpdateConfirmTransactionDialog,
	ConfirmTransactionDialogPendingChanged,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_initiate_export_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	ImportSettingsReply,
	ActiveSigningAddressChanged,
	UpdateRPCList,
)

export type ExternalPopupMessage = funtypes.Static<typeof MessageToPopup>
export const ExternalPopupMessage = funtypes.Union(MessageToPopup, PopupMessage) // message that moves from popup to another, or from background page to popup, or from popup to background page
