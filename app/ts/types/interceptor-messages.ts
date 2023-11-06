import * as funtypes from 'funtypes'
import { PendingChainChangeConfirmationPromise, RpcConnectionStatus, TabIconDetails } from './user-interface-types.js'
import { EthereumAddress, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, NonHexBigInt, OptionalEthereumAddress } from './wire-types.js'
import { CompleteVisualizedSimulation, NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState, TokenPriceEstimate, VisualizerResult } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { EthGetLogsResponse, EthGetStorageAtParams, EthTransactionReceiptResponse, GetBlockReturn, GetSimulationStackReply, SendRawTransactionParams, SendTransactionParams, WalletAddEthereumChain } from './JsonRpc-types.js'
import { AddressBookEntries, AddressBookEntry, ActiveAddressEntry, UserAddressBook } from './addressBookTypes.js'
import { Page } from './exportedSettingsTypes.js'
import { Website, WebsiteAccessArray } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { ConfirmTransactionDialogState, PendingAccessRequestArray, PendingTransaction } from './accessRequest.js'
import { RpcEntries, RpcEntry, RpcNetwork } from './rpc.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from './jsonRpc-signing-types.js'

export type WalletSwitchEthereumChainReply = funtypes.Static<typeof WalletSwitchEthereumChainReply>
export const WalletSwitchEthereumChainReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_switchEthereumChain_reply'),
	params: funtypes.Tuple(funtypes.ReadonlyObject({
		accept: funtypes.Boolean,
		chainId: EthereumQuantity,
	}))
}).asReadonly()

export type InpageScriptRequestWithoutIdentifier = funtypes.Static<typeof InpageScriptRequestWithoutIdentifier>
export const InpageScriptRequestWithoutIdentifier = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts_reply'), result: funtypes.Literal('0x') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signer_chainChanged'), result: funtypes.Literal('0x') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('connected_to_signer'), result: funtypes.ReadonlyObject({ metamaskCompatibilityMode: funtypes.Boolean}) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain_reply'), result: funtypes.Literal('0x') }),
)

export type InpageScriptRequest = funtypes.Static<typeof InpageScriptRequest>
export const InpageScriptRequest = funtypes.Intersect(
	funtypes.ReadonlyObject({ uniqueRequestIdentifier: UniqueRequestIdentifier }),
	InpageScriptRequestWithoutIdentifier,
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
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByHash'), result: GetBlockReturn }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBalance'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_estimateGas'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionByHash'), result: funtypes.Union(EthereumSignedTransactionWithBlockData, funtypes.Undefined) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionReceipt'), result: EthTransactionReceiptResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_subscribe'), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_unsubscribe'), result: funtypes.Boolean }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('net_version'), result: NonHexBigInt }),
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
	funtypes.ReadonlyObject({ method: funtypes.Literal('web3_clientVersion'), result: funtypes.String }),
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
	funtypes.Union(SendRawTransactionParams, SendTransactionParams, PersonalSignParams, SignTypedDataParams, OldSignTypedDataParams, WalletAddEthereumChain, EthGetStorageAtParams),
)

export type UnknownMethodForward = funtypes.Static<typeof UnknownMethodForward>
export const UnknownMethodForward = funtypes.Intersect(
	funtypes.ReadonlyObject({
		forward: funtypes.Literal(true),
		unknownMethod: funtypes.Literal(true),
		method: funtypes.String,
	}),
	funtypes.Partial({
		params: funtypes.Unknown,
	})
)

export type RPCReply = funtypes.Static<typeof RPCReply>
export const RPCReply = funtypes.Union(
	NonForwardingRPCRequestReturnValue,
	ForwardToWallet,
	UnknownMethodForward,
)

export type SubscriptionReplyOrCallBack = funtypes.Static<typeof SubscriptionReplyOrCallBack>
export const SubscriptionReplyOrCallBack = funtypes.Union(
	InpageScriptCallBack,
	funtypes.Intersect(
		funtypes.ReadonlyObject({
			method: funtypes.String,
			subscription: funtypes.String,
		}),
		SubscriptionReturnValue,
	),
)

export type InterceptedRequestForwardWithRequestId = funtypes.Static<typeof InterceptedRequestForwardWithRequestId>
export const InterceptedRequestForwardWithRequestId = funtypes.Intersect(
	funtypes.ReadonlyObject({ requestId: funtypes.Number }),
	funtypes.Union(RPCReply, InpageScriptRequestWithoutIdentifier),
)

export type InterceptedRequestForward = funtypes.Static<typeof InterceptedRequestForward>
export const InterceptedRequestForward = funtypes.Intersect(
	funtypes.ReadonlyObject({ uniqueRequestIdentifier: UniqueRequestIdentifier }),
	funtypes.Union(RPCReply, InpageScriptRequestWithoutIdentifier),
)

export type InterceptorMessageToInpage = funtypes.Static<typeof InterceptorMessageToInpage>
export const InterceptorMessageToInpage = funtypes.Intersect(
	funtypes.ReadonlyObject({ interceptorApproved: funtypes.Literal(true) }),
	funtypes.Union(InterceptedRequestForwardWithRequestId, SubscriptionReplyOrCallBack)
)

export type RefreshConfirmTransactionMetadata = funtypes.Static<typeof RefreshConfirmTransactionMetadata>
export const RefreshConfirmTransactionMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshConfirmTransactionMetadata'),
	data: ConfirmTransactionDialogState
}).asReadonly()

export type IdentifyAddress = funtypes.Static<typeof IdentifyAddress>
export const IdentifyAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_identifyAddress'),
	data: funtypes.ReadonlyObject({ address: EthereumAddress })
}).asReadonly()

export type IdentifyAddressReply = funtypes.Static<typeof IdentifyAddressReply>
export const IdentifyAddressReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_identifyAddressReply'),
	data: funtypes.ReadonlyObject({ addressBookEntry: AddressBookEntry })
}).asReadonly()

export type TransactionConfirmation = funtypes.Static<typeof TransactionConfirmation>
export const TransactionConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_confirmDialog'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			uniqueRequestIdentifier: UniqueRequestIdentifier,
			accept: funtypes.Literal(true),
			windowId: funtypes.Number,
		}),
		funtypes.ReadonlyObject({
			uniqueRequestIdentifier: UniqueRequestIdentifier,
			accept: funtypes.Literal(false),
			windowId: funtypes.Number,
			transactionErrorString: funtypes.Union(funtypes.String, funtypes.Undefined),
		})
	)
}).asReadonly()

export type PersonalSignApproval = funtypes.Static<typeof PersonalSignApproval>
export const PersonalSignApproval = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_personalSignApproval'),
	data: funtypes.ReadonlyObject({
		uniqueRequestIdentifier: UniqueRequestIdentifier,
		accept: funtypes.Boolean
	})
}).asReadonly()

export type InterceptorAccessRefresh = funtypes.Static<typeof InterceptorAccessRefresh>
export const InterceptorAccessRefresh = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccessRefresh'),
	data: funtypes.ReadonlyObject({
		socket: WebsiteSocket,
		accessRequestId: funtypes.String,
		website: Website,
		requestAccessToAddress: OptionalEthereumAddress,
	}),
}).asReadonly()

export type RefreshInterceptorAccessMetadata = funtypes.Static<typeof RefreshInterceptorAccessMetadata>
export const RefreshInterceptorAccessMetadata = funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshInterceptorAccessMetadata') }).asReadonly()

export type InterceptorAccessChangeAddress = funtypes.Static<typeof InterceptorAccessChangeAddress>
export const InterceptorAccessChangeAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccessChangeAddress'),
	data: funtypes.ReadonlyObject({
		socket: WebsiteSocket,
		accessRequestId: funtypes.String,
		website: Website,
		requestAccessToAddress: OptionalEthereumAddress,
		newActiveAddress: funtypes.Union(EthereumAddress, funtypes.Literal('signer')),
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
	funtypes.Literal('ERC20 Tokens'),
	funtypes.Literal('ERC1155 Tokens'),
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

export type RemoveSignedMessage = funtypes.Static<typeof RemoveSignedMessage>
export const RemoveSignedMessage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeSignedMessage'),
	data: UniqueRequestIdentifier,
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

export type NewBlockArrivedOrFailedToArrive = funtypes.Static<typeof NewBlockArrivedOrFailedToArrive>
export const NewBlockArrivedOrFailedToArrive = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_new_block_arrived'), funtypes.Literal('popup_failed_to_get_block')),
	data: funtypes.ReadonlyObject({ rpcConnectionStatus: RpcConnectionStatus }),
}).asReadonly()

export type WebsiteIconChanged = funtypes.Static<typeof WebsiteIconChanged>
export const WebsiteIconChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_websiteIconChanged'),
	data: TabIconDetails
})

export type SimulationUpdateStartedOrEnded = funtypes.Static<typeof SimulationUpdateStartedOrEnded>
export const SimulationUpdateStartedOrEnded = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulation_state_changed'),
	data: funtypes.ReadonlyObject({ simulationId: funtypes.Number })
})

export type MessageToPopupSimple = funtypes.Static<typeof MessageToPopupSimple>
export const MessageToPopupSimple = funtypes.ReadonlyObject({
	method: funtypes.Union(
		funtypes.Literal('popup_chain_update'),
		funtypes.Literal('popup_confirm_transaction_simulation_started'),
		funtypes.Literal('popup_accounts_update'),
		funtypes.Literal('popup_addressBookEntriesChanged'),
		funtypes.Literal('popup_interceptor_access_changed'),
		funtypes.Literal('popup_notification_removed'),
		funtypes.Literal('popup_signer_name_changed'),
		funtypes.Literal('popup_websiteAccess_changed'),
	)
}).asReadonly()

export type PartiallyParsedPersonalSignRequest = funtypes.Static<typeof PartiallyParsedPersonalSignRequest>
export const PartiallyParsedPersonalSignRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_personal_sign_request'),
	data: funtypes.Unknown,
})

export type PartiallyParsedRefreshPersonalSignMetadata = funtypes.Static<typeof PartiallyParsedRefreshPersonalSignMetadata>
export const PartiallyParsedRefreshPersonalSignMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshPersonalSignMetadata'),
	data: funtypes.Unknown,
})

export type PersonalSignRequest = funtypes.Static<typeof PersonalSignRequest>
export const PersonalSignRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_personal_sign_request'),
	data: VisualizedPersonalSignRequest,
})

export type RefreshPersonalSignMetadata = funtypes.Static<typeof RefreshPersonalSignMetadata>
export const RefreshPersonalSignMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshPersonalSignMetadata'),
	data: VisualizedPersonalSignRequest,
})

export type RefreshConfirmTransactionDialogSimulation = funtypes.Static<typeof RefreshConfirmTransactionDialogSimulation>
export const RefreshConfirmTransactionDialogSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshConfirmTransactionDialogSimulation'),
	data: funtypes.ReadonlyObject({})
}).asReadonly()

export type UpdateConfirmTransactionDialog = funtypes.Static<typeof UpdateConfirmTransactionDialog>
export const UpdateConfirmTransactionDialog = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
	data: funtypes.ReadonlyArray(PendingTransaction),
}).asReadonly()

export type ConfirmTransactionDialogPendingChanged = funtypes.Static<typeof ConfirmTransactionDialogPendingChanged>
export const ConfirmTransactionDialogPendingChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_confirm_transaction_dialog_pending_changed'),
	data: funtypes.ReadonlyArray(PendingTransaction),
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


export type InterceptorAccessDialog = funtypes.Static<typeof InterceptorAccessDialog>
export const InterceptorAccessDialog = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_interceptorAccessDialog'), funtypes.Literal('popup_interceptor_access_dialog_pending_changed')),
	data: PendingAccessRequestArray
})

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

export type PartialUpdateHomePage = funtypes.Static<typeof PartialUpdateHomePage>
export const PartialUpdateHomePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UpdateHomePage'),
	data: funtypes.Unknown,
})

export type UpdateHomePage = funtypes.Static<typeof UpdateHomePage>
export const UpdateHomePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UpdateHomePage'),
	data: funtypes.ReadonlyObject({
		visualizedSimulatorState: funtypes.Union(CompleteVisualizedSimulation, funtypes.Undefined),
		websiteAccessAddressMetadata: funtypes.ReadonlyArray(ActiveAddressEntry),
		signerAccounts: funtypes.Union(funtypes.ReadonlyArray(EthereumAddress), funtypes.Undefined),
		signerChain: funtypes.Union(EthereumQuantity, funtypes.Undefined),
		signerName: SignerName,
		currentBlockNumber: funtypes.Union(EthereumQuantity, funtypes.Undefined),
		settings: Settings,
		tabIconDetails: funtypes.Union(TabIconDetails, funtypes.Undefined),
		makeMeRich: funtypes.Boolean,
		rpcConnectionStatus: RpcConnectionStatus,
		useTabsInsteadOfPopup: funtypes.Boolean,
		metamaskCompatibilityMode: funtypes.Boolean,
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

export type ChangeSettings = funtypes.Static<typeof ChangeSettings>
export const ChangeSettings = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_ChangeSettings'),
	data: funtypes.ReadonlyPartial({
		useTabsInsteadOfPopup: funtypes.Boolean,
		metamaskCompatibilityMode: funtypes.Boolean,
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
		uniqueRequestIdentifier: UniqueRequestIdentifier,
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

export type FindAddressBookEntryWithSymbolOrName = funtypes.Static<typeof FindAddressBookEntryWithSymbolOrName>
export const FindAddressBookEntryWithSymbolOrName = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_findAddressBookEntryWithSymbolOrName'),
	data: funtypes.ReadonlyObject({
		symbol: funtypes.Union(funtypes.String, funtypes.Undefined),
		name: funtypes.Union(funtypes.String, funtypes.Undefined),
	})
})

export type FindAddressBookEntryWithSymbolOrNameReply = funtypes.Static<typeof FindAddressBookEntryWithSymbolOrNameReply>
export const FindAddressBookEntryWithSymbolOrNameReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_findAddressBookEntryWithSymbolOrNameReply'),
	data: funtypes.ReadonlyObject({
		query: funtypes.ReadonlyObject({ 
			symbol: funtypes.Union(funtypes.String, funtypes.Undefined),
			name: funtypes.Union(funtypes.String, funtypes.Undefined),
		}),
		addressBookEntryOrUndefined: funtypes.Union(funtypes.Undefined, AddressBookEntry),
	})
}).asReadonly()

export type PartiallyParsedSimulateGovernanceContractExecutionReply = funtypes.Static<typeof PartiallyParsedSimulateGovernanceContractExecutionReply>
export const PartiallyParsedSimulateGovernanceContractExecutionReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGovernanceContractExecutionReply'),
	data: funtypes.Unknown,
}).asReadonly()

export type SimulateGovernanceContractExecutionReply = funtypes.Static<typeof SimulateGovernanceContractExecutionReply>
export const SimulateGovernanceContractExecutionReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGovernanceContractExecutionReply'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			success: funtypes.Literal(false),
			error: funtypes.Union(
				funtypes.ReadonlyObject({
					type: funtypes.Literal('MissingAbi'),
					message: funtypes.String,
					addressBookEntry: AddressBookEntry,
				}),	
			)
		}),
		funtypes.ReadonlyObject({
			success: funtypes.Literal(false),
			error: funtypes.Union(
				funtypes.ReadonlyObject({
					type: funtypes.Literal('Other'),
					message: funtypes.String,
				}),	
			)
		}),
		funtypes.ReadonlyObject({
			success: funtypes.Literal(true),
			result: funtypes.ReadonlyObject({
				namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
				addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
				simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
				visualizedPersonalSignRequests: funtypes.ReadonlyArray(VisualizedPersonalSignRequest),
				tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
				visualizerResults: funtypes.ReadonlyArray(VisualizerResult),
				protectors: funtypes.ReadonlyArray(ProtectorResults),
				simulationState: funtypes.Union(SimulationState),
			})
		})
	)
}).asReadonly()

export type FetchAbiAndNameFromEtherScan = funtypes.Static<typeof FetchAbiAndNameFromEtherScan>
export const FetchAbiAndNameFromEtherScan = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_fetchAbiAndNameFromEtherScan'),
	data: EthereumAddress,
}).asReadonly()

export type FetchAbiAndNameFromEtherScanReply = funtypes.Static<typeof FetchAbiAndNameFromEtherScanReply>
export const FetchAbiAndNameFromEtherScanReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_fetchAbiAndNameFromEtherScanReply'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			address: EthereumAddress,
			abi: funtypes.Union(funtypes.String, funtypes.Undefined),
			contractName: funtypes.String,
		}),
		funtypes.Undefined,
	)
}).asReadonly()

export type PopupMessage = funtypes.Static<typeof PopupMessage>
export const PopupMessage = funtypes.Union(
	TransactionConfirmation,
	RemoveTransaction,
	RemoveSignedMessage,
	ResetSimulation,
	RefreshSimulation,
	ChangeMakeMeRich,
	ChangeActiveAddress,
	ChangePage,
	RequestAccountsFromSigner,
	RefreshConfirmTransactionDialogSimulation,
	RefreshConfirmTransactionMetadata,
	PersonalSignApproval,
	PartiallyParsedRefreshPersonalSignMetadata,
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
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_personalSignReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_changeChainReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_interceptorAccessReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_confirmTransactionReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestNewHomeData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_homeOpened') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_import_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_get_export_settings') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_simulateGovernanceContractExecution') }),
	ChangeSettings,
	SetRpcList,
	IdentifyAddress,
	FindAddressBookEntryWithSymbolOrName,
	FetchAbiAndNameFromEtherScan,
)

export type MessageToPopup = funtypes.Static<typeof MessageToPopup>
export const MessageToPopup = funtypes.Union(
	MessageToPopupSimple,
	WebsiteIconChanged,
	GetAddressBookDataReply,
	ChangeChainRequest,
	InterceptorAccessDialog,
	NewBlockArrivedOrFailedToArrive,
	SettingsUpdated,
	UpdateConfirmTransactionDialog,
	ConfirmTransactionDialogPendingChanged,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_initiate_export_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	ImportSettingsReply,
	ActiveSigningAddressChanged,
	UpdateRPCList,
	SimulationUpdateStartedOrEnded,
	IdentifyAddressReply,
	FindAddressBookEntryWithSymbolOrNameReply,
	PartialUpdateHomePage,
	PartiallyParsedPersonalSignRequest,
	PartiallyParsedSimulateGovernanceContractExecutionReply,
	FetchAbiAndNameFromEtherScanReply,
)

export type ExternalPopupMessage = funtypes.Static<typeof MessageToPopup>
export const ExternalPopupMessage = funtypes.Union(MessageToPopup, PopupMessage)
