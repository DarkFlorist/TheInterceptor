import * as funtypes from 'funtypes'
import { PendingChainChangeConfirmationPromise, RpcConnectionStatus, TabIconDetails, TabState } from './user-interface-types.js'
import { EthereumAddress, EthereumBlockHeaderWithTransactionHashes, EthereumBytes32, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, NonHexBigInt, OptionalEthereumAddress } from './wire-types.js'
import { ModifyAddressWindowState, CompleteVisualizedSimulation, NamedTokenId, SimulationState, TokenPriceEstimate, VisualizedSimulationState, BlockTimeManipulation, BlockTimeManipulationWithNoDelay } from './visualizer-types.js'
import { VisualizedPersonalSignRequestSafeTx } from './personal-message-definitions.js'
import { UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { EthGetFeeHistoryResponse, EthGetLogsResponse, EthGetStorageAtParams, EthTransactionReceiptResponse, GetBlockReturn, SendRawTransactionParams, SendTransactionParams, WalletAddEthereumChain } from './JsonRpc-types.js'
import { AddressBookEntries, AddressBookEntry, ChainIdWithUniversal } from './addressBookTypes.js'
import { Page } from './exportedSettingsTypes.js'
import { Website, WebsiteAccess, WebsiteAccessArray } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { PendingAccessRequests, PendingTransactionOrSignableMessage } from './accessRequest.js'
import { CodeMessageError, RpcEntries, RpcEntry, RpcNetwork } from './rpc.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from './jsonRpc-signing-types.js'
import { GetSimulationStackReplyV1, GetSimulationStackReplyV2 } from './simulationStackTypes.js'
import { PopupMessageReplyRequests, UnexpectedErrorOccured } from './interceptor-reply-messages.js'

type WalletSwitchEthereumChainReplyParams = funtypes.Static<typeof WalletSwitchEthereumChainReplyParams>
const WalletSwitchEthereumChainReplyParams = funtypes.Tuple(funtypes.Union(
	funtypes.ReadonlyObject({
		accept: funtypes.Literal(true),
		chainId: EthereumQuantity,
	}),
	funtypes.ReadonlyObject({
		accept: funtypes.Literal(false),
		chainId: EthereumQuantity,
		error: funtypes.ReadonlyObject({
			code: funtypes.Number,
			message: funtypes.String,
		})
	})
))


export type WalletSwitchEthereumChainReply = funtypes.Static<typeof WalletSwitchEthereumChainReply>
export const WalletSwitchEthereumChainReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_switchEthereumChain_reply'),
	params: WalletSwitchEthereumChainReplyParams
}).asReadonly()

type InpageScriptRequestWithoutIdentifier = funtypes.Static<typeof InpageScriptRequestWithoutIdentifier>
const InpageScriptRequestWithoutIdentifier = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('doNotReply') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signer_connection_status_changed'), result: funtypes.Literal('0x') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signer_reply'), result: funtypes.Unknown }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts_reply'), result: funtypes.Literal('0x') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('signer_chainChanged'), result: funtypes.Literal('0x') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('connected_to_signer'), result: funtypes.ReadonlyObject({ metamaskCompatibilityMode: funtypes.Boolean, activeAddress: funtypes.String }) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain_reply'), result: funtypes.Literal('0x') }),
)

export type InpageScriptRequest = funtypes.Static<typeof InpageScriptRequest>
export const InpageScriptRequest = funtypes.Intersect(
	funtypes.ReadonlyObject({ uniqueRequestIdentifier: UniqueRequestIdentifier, type: funtypes.Literal('result') }),
	InpageScriptRequestWithoutIdentifier,
)

type ErrorReturn = funtypes.Static<typeof ErrorReturn>
const ErrorReturn = funtypes.ReadonlyObject({
	method: funtypes.String,
	error: funtypes.Intersect(CodeMessageError, funtypes.ReadonlyPartial({ data: funtypes.String }))
})

export type InpageScriptCallBack = funtypes.Static<typeof InpageScriptCallBack>
export const InpageScriptCallBack = funtypes.Union(
	ErrorReturn,
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_chainId'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_wallet_switchEthereumChain'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_requestAccounts'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('request_signer_to_eth_accounts'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('disconnect'), result: funtypes.ReadonlyTuple() }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('connect'), result: funtypes.ReadonlyTuple(EthereumQuantity) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('accountsChanged'), result: funtypes.ReadonlyArray(EthereumAddress) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('chainChanged'), result: EthereumQuantity }),
)

type NonForwardingRPCRequestSuccessfullReturnValue = funtypes.Static<typeof NonForwardingRPCRequestSuccessfullReturnValue>
const NonForwardingRPCRequestSuccessfullReturnValue = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByNumber'), result: GetBlockReturn }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBlockByHash'), result: GetBlockReturn }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getBalance'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_estimateGas'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionByHash'), result: funtypes.Union(EthereumSignedTransactionWithBlockData, funtypes.Null) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionReceipt'), result: EthTransactionReceiptResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_subscribe'), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_newFilter'), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_unsubscribe'), result: funtypes.Boolean }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_uninstallFilter'), result: funtypes.Boolean }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('net_version'), result: NonHexBigInt }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getCode'), result: EthereumData }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_switchEthereumChain'), result: funtypes.Null }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts'), result: funtypes.ReadonlyArray(EthereumAddress) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions'), result: funtypes.ReadonlyTuple(funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({}) })) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getTransactionCount'), result: EthereumQuantity }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('interceptor_getSimulationStack'), result: funtypes.Union(
		funtypes.ReadonlyObject({ version: funtypes.Union(funtypes.Literal('1.0.0'), funtypes.Literal('1.0.1')), payload: GetSimulationStackReplyV1 }),
		funtypes.ReadonlyObject({ version: funtypes.Literal('2.0.0'), payload: GetSimulationStackReplyV2 })
	) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getLogs'), result: EthGetLogsResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendRawTransaction'), result: EthereumBytes32 }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_sendTransaction'), result: EthereumBytes32 }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_call'), result: EthereumData }),
	funtypes.ReadonlyObject({ method: funtypes.Union(funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4'), funtypes.Literal('eth_signTypedData')), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('web3_clientVersion'), result: funtypes.String }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_feeHistory'), result: EthGetFeeHistoryResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getFilterChanges'), result: EthGetLogsResponse }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_getFilterLogs'), result: EthGetLogsResponse }),
)

type SubscriptionReturnValue = funtypes.Static<typeof SubscriptionReturnValue>
const SubscriptionReturnValue = funtypes.ReadonlyObject({
	method: funtypes.Literal('newHeads'),
	result: funtypes.ReadonlyObject({
		subscription: funtypes.Literal('newHeads'),
		result: EthereumBlockHeaderWithTransactionHashes
	})
})

type NonForwardingRPCRequestReturnValue = funtypes.Static<typeof NonForwardingRPCRequestReturnValue>
const NonForwardingRPCRequestReturnValue = funtypes.Intersect(
	funtypes.ReadonlyObject({ type: funtypes.Literal('result') }),
	funtypes.Union(NonForwardingRPCRequestSuccessfullReturnValue, ErrorReturn)
)

type ForwardToWallet = funtypes.Static<typeof ForwardToWallet>
const ForwardToWallet = funtypes.Intersect( // forward directly to wallet
	funtypes.ReadonlyObject({ type: funtypes.Literal('forwardToSigner') }),
	funtypes.Union(SendRawTransactionParams, SendTransactionParams, PersonalSignParams, SignTypedDataParams, OldSignTypedDataParams, WalletAddEthereumChain, EthGetStorageAtParams),
)

type ReplyWithSignersReplyForward = funtypes.Static<typeof ReplyWithSignersReplyForward>
const ReplyWithSignersReplyForward = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('forwardToSigner'),
		replyWithSignersReply: funtypes.Literal(true),
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
	ReplyWithSignersReplyForward,
	funtypes.ReadonlyObject({ type: funtypes.Literal('doNotReply') }),
)

export type SubscriptionReplyOrCallBack = funtypes.Static<typeof SubscriptionReplyOrCallBack>
export const SubscriptionReplyOrCallBack = funtypes.Intersect(
	funtypes.ReadonlyObject({ type: funtypes.Literal('result') }),
	funtypes.Union(
		InpageScriptCallBack,
		funtypes.Intersect(
			funtypes.ReadonlyObject({
				method: funtypes.String,
				subscription: funtypes.String,
			}),
			SubscriptionReturnValue,
		)
	)
)

type InterceptedRequestForwardWithRequestId = funtypes.Static<typeof InterceptedRequestForwardWithRequestId>
const InterceptedRequestForwardWithRequestId = funtypes.Intersect(
	funtypes.ReadonlyObject({ requestId: funtypes.Number }),
	funtypes.Union(RPCReply, funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), InpageScriptRequestWithoutIdentifier)),
)

export type InterceptedRequestForward = funtypes.Static<typeof InterceptedRequestForward>
export const InterceptedRequestForward = funtypes.Intersect(
	funtypes.ReadonlyObject({ uniqueRequestIdentifier: UniqueRequestIdentifier }),
	funtypes.Union(RPCReply, funtypes.Intersect(funtypes.ReadonlyObject({ type: funtypes.Literal('result') }), InpageScriptRequestWithoutIdentifier)),
)

export type InterceptorMessageToInpage = funtypes.Static<typeof InterceptorMessageToInpage>
export const InterceptorMessageToInpage = funtypes.Intersect(
	funtypes.ReadonlyObject({ interceptorApproved: funtypes.Literal(true) }),
	funtypes.Union(InterceptedRequestForwardWithRequestId, SubscriptionReplyOrCallBack)
)

type RefreshConfirmTransactionMetadata = funtypes.Static<typeof RefreshConfirmTransactionMetadata>
const RefreshConfirmTransactionMetadata = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshConfirmTransactionMetadata')
}).asReadonly()

export type TransactionConfirmation = funtypes.Static<typeof TransactionConfirmation>
export const TransactionConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_confirmDialog'),
	data: funtypes.Union(
		funtypes.Intersect(
			funtypes.ReadonlyObject({
				uniqueRequestIdentifier: UniqueRequestIdentifier,
			}),
			funtypes.Union(
				funtypes.ReadonlyObject({
					action: funtypes.Literal('signerIncluded'),
					signerReply: funtypes.Unknown,
				}),
				funtypes.ReadonlyObject({
					action: funtypes.Union(funtypes.Literal('accept'), funtypes.Literal('noResponse')),
				}),
				funtypes.ReadonlyObject({
					action: funtypes.Literal('reject'),
					errorString: funtypes.Union(funtypes.String, funtypes.Undefined),
				}),
			)
		)
	)
})

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

type RefreshInterceptorAccessMetadata = funtypes.Static<typeof RefreshInterceptorAccessMetadata>
const RefreshInterceptorAccessMetadata = funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshInterceptorAccessMetadata') }).asReadonly()

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

export type ModifyMakeMeRich = funtypes.Static<typeof ModifyMakeMeRich>
export const ModifyMakeMeRich = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_modifyMakeMeRich'),
	data: funtypes.ReadonlyObject({
		add: funtypes.Boolean,
		address: funtypes.Union(funtypes.Literal('CurrentAddress'), funtypes.Literal('KeepSelectedAddressRichEvenIfIChangeAddress'), EthereumAddress)
	})
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
		chainId: ChainIdWithUniversal,
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

export type TransactionOrMessageIdentifier = funtypes.Static<typeof TransactionOrMessageIdentifier>
export const TransactionOrMessageIdentifier = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('Transaction'), transactionIdentifier: EthereumQuantity }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('Message'), messageIdentifier: EthereumQuantity })
)

export type RemoveTransaction = funtypes.Static<typeof RemoveTransaction>
export const RemoveTransaction = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeTransactionOrSignedMessage'),
	data: TransactionOrMessageIdentifier
}).asReadonly()

type ResetSimulation = funtypes.Static<typeof ResetSimulation>
const ResetSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_resetSimulation')
}).asReadonly()

type RefreshSimulation = funtypes.Static<typeof RefreshSimulation>
const RefreshSimulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_refreshSimulation')
}).asReadonly()

export type ChangeInterceptorAccess = funtypes.Static<typeof ChangeInterceptorAccess>
export const ChangeInterceptorAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeInterceptorAccess'),
	data: funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			removed: funtypes.Boolean,
			oldEntry: WebsiteAccess,
			newEntry: WebsiteAccess
		})
	)
}).asReadonly()

export type BlockOrAllowExternalRequests = funtypes.Static<typeof BlockOrAllowExternalRequests>
export const BlockOrAllowExternalRequests = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_blockOrAllowExternalRequests'),
	data: funtypes.Object({
		website: Website,
		shouldBlock: funtypes.Boolean
	})
}).asReadonly()

export type AllowOrPreventAddressAccessForWebsite = funtypes.Static<typeof AllowOrPreventAddressAccessForWebsite>
export const AllowOrPreventAddressAccessForWebsite = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_allowOrPreventAddressAccessForWebsite'),
	data: funtypes.Object({
		website: Website,
		address: EthereumAddress,
		allowAccess: funtypes.Boolean
	})
}).asReadonly()

export type RemoveWebsiteAddressAccess = funtypes.Static<typeof RemoveWebsiteAddressAccess>
export const RemoveWebsiteAddressAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeWebsiteAddressAccess'),
	data: funtypes.Object({
		websiteOrigin: funtypes.String,
		address: EthereumAddress
	})
}).asReadonly()

export type RemoveWebsiteAccess = funtypes.Static<typeof RemoveWebsiteAccess>
export const RemoveWebsiteAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_removeWebsiteAccess'),
	data: funtypes.Object({ websiteOrigin: funtypes.String })
}).asReadonly()

export type SignerChainChangeConfirmation = funtypes.Static<typeof SignerChainChangeConfirmation>
export const SignerChainChangeConfirmation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_signerChangeChainDialog'),
	data: WalletSwitchEthereumChainReplyParams,
}).asReadonly()

export type ConnectedToSigner = funtypes.Static<typeof ConnectedToSigner>
export const ConnectedToSigner = funtypes.ReadonlyObject({
	method: funtypes.Literal('connected_to_signer'),
	params: funtypes.Tuple(funtypes.Boolean, SignerName),
}).asReadonly()


type SignerReplyForwardRequest = funtypes.Static<typeof SignerReplyForwardRequest>
const SignerReplyForwardRequest = funtypes.Intersect(
	funtypes.ReadonlyObject({ requestId: funtypes.Number }),
	funtypes.Union(ForwardToWallet, ReplyWithSignersReplyForward)
)

export type SignerReply = funtypes.Static<typeof SignerReply>
export const SignerReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('signer_reply'),
	params: funtypes.Tuple(funtypes.Union(
		funtypes.ReadonlyObject({
			success: funtypes.Literal(true),
			forwardRequest: SignerReplyForwardRequest,
			reply: funtypes.Unknown,
		}),
		funtypes.ReadonlyObject({
			success: funtypes.Literal(false),
			forwardRequest: SignerReplyForwardRequest,
			error: funtypes.Intersect(
				CodeMessageError,
				funtypes.ReadonlyPartial({ data: funtypes.Unknown })
			)
		})

	)),
}).asReadonly()

export type GetAddressBookDataFilter = funtypes.Static<typeof GetAddressBookDataFilter>
export const GetAddressBookDataFilter = funtypes.Intersect(
	funtypes.ReadonlyObject({
		filter: AddressBookCategory,
		chainId: ChainIdWithUniversal,
	}).asReadonly(),
	funtypes.Partial({
		startIndex: funtypes.Number,
		maxIndex: funtypes.Number,
		searchString: funtypes.String,
	}).asReadonly()
)

export type GetAddressBookData = funtypes.Static<typeof GetAddressBookData>
export const GetAddressBookData = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_getAddressBookData'),
	data: GetAddressBookDataFilter,
}).asReadonly()

type OpenAddressBook = funtypes.Static<typeof OpenAddressBook>
const OpenAddressBook = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_openAddressBook'),
}).asReadonly()

export type GetAddressBookDataReply = funtypes.Static<typeof GetAddressBookDataReply>
export const GetAddressBookDataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_getAddressBookDataReply'),
	data: funtypes.ReadonlyObject({
		data: GetAddressBookDataFilter,
		entries: AddressBookEntries,
		maxDataLength: funtypes.Number,
	}),
}).asReadonly()

type NewBlockArrivedOrFailedToArrive = funtypes.Static<typeof NewBlockArrivedOrFailedToArrive>
const NewBlockArrivedOrFailedToArrive = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_new_block_arrived'), funtypes.Literal('popup_failed_to_get_block')),
	data: funtypes.ReadonlyObject({ rpcConnectionStatus: RpcConnectionStatus }),
}).asReadonly()

type WebsiteIconChanged = funtypes.Static<typeof WebsiteIconChanged>
const WebsiteIconChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_websiteIconChanged'),
	data: TabIconDetails
})

type SimulationUpdateStartedOrEnded = funtypes.Static<typeof SimulationUpdateStartedOrEnded>
const SimulationUpdateStartedOrEnded = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulation_state_changed'),
	data: funtypes.ReadonlyObject({ simulationId: funtypes.Number })
})

type MessageToPopupSimple = funtypes.Static<typeof MessageToPopupSimple>
const MessageToPopupSimple = funtypes.ReadonlyObject({
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

export type UpdateConfirmTransactionDialog = funtypes.Static<typeof UpdateConfirmTransactionDialog>
export const UpdateConfirmTransactionDialog = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
	data: funtypes.ReadonlyObject({
		visualizedSimulatorState: funtypes.Union(CompleteVisualizedSimulation, funtypes.Undefined),
		currentBlockNumber: EthereumQuantity,
	})
}).asReadonly()

type UpdateConfirmTransactionDialogPartial = funtypes.Static<typeof UpdateConfirmTransactionDialogPartial>
const UpdateConfirmTransactionDialogPartial = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_update_confirm_transaction_dialog'),
	data: funtypes.Unknown
}).asReadonly()

export type UpdateConfirmTransactionDialogPendingTransactions = funtypes.Static<typeof UpdateConfirmTransactionDialogPendingTransactions>
export const UpdateConfirmTransactionDialogPendingTransactions = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_update_confirm_transaction_dialog_pending_transactions'),
	data: funtypes.ReadonlyObject({
		pendingTransactionAndSignableMessages: funtypes.ReadonlyArray(PendingTransactionOrSignableMessage),
		currentBlockNumber: EthereumQuantity,
	})
}).asReadonly()


export type InterceptorAccessReply = funtypes.Static<typeof InterceptorAccessReply>
export const InterceptorAccessReply = funtypes.ReadonlyObject({
	accessRequestId: funtypes.String,
	originalRequestAccessToAddress: OptionalEthereumAddress,
	requestAccessToAddress: OptionalEthereumAddress,
	userReply: funtypes.Union(funtypes.Literal('Approved'), funtypes.Literal('Rejected'), funtypes.Literal('noResponse') ),
})

export type InterceptorAccess = funtypes.Static<typeof InterceptorAccess>
export const InterceptorAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_interceptorAccess'),
	data: InterceptorAccessReply,
}).asReadonly()


type InterceptorAccessDialog = funtypes.Static<typeof InterceptorAccessDialog>
const InterceptorAccessDialog = funtypes.ReadonlyObject({
	method: funtypes.Union(funtypes.Literal('popup_interceptorAccessDialog'), funtypes.Literal('popup_interceptor_access_dialog_pending_changed')),
	data: funtypes.ReadonlyObject({
		activeAddresses: AddressBookEntries,
		pendingAccessRequests: PendingAccessRequests,
	})
})

export type Settings = funtypes.Static<typeof Settings>
export const Settings = funtypes.ReadonlyObject({
	activeSimulationAddress: OptionalEthereumAddress,
	activeRpcNetwork: RpcNetwork,
	openedPage: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
})

type PartialUpdateHomePage = funtypes.Static<typeof PartialUpdateHomePage>
const PartialUpdateHomePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UpdateHomePage'),
	data: funtypes.Unknown,
})

export type UpdateHomePage = funtypes.Static<typeof UpdateHomePage>
export const UpdateHomePage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UpdateHomePage'),
	data: funtypes.ReadonlyObject({
		visualizedSimulatorState: funtypes.Union(CompleteVisualizedSimulation, funtypes.Undefined),
		websiteAccessAddressMetadata: AddressBookEntries,
		tabState: TabState,
		currentBlockNumber: funtypes.Union(EthereumQuantity, funtypes.Undefined),
		settings: Settings,
		rpcConnectionStatus: funtypes.Union(RpcConnectionStatus, funtypes.Undefined),
		activeSigningAddressInThisTab: OptionalEthereumAddress,
		tabId: funtypes.Union(funtypes.Number, funtypes.Undefined),
		rpcEntries: RpcEntries,
		interceptorDisabled: funtypes.Boolean,
		preSimulationBlockTimeManipulation: BlockTimeManipulation,
	})
})

type ActiveSigningAddressChanged = funtypes.Static<typeof ActiveSigningAddressChanged>
const ActiveSigningAddressChanged = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_activeSigningAddressChanged'),
	data: funtypes.ReadonlyObject({
		tabId: funtypes.Number,
		activeSigningAddress: OptionalEthereumAddress,
	})
})

type WindowMessageSignerAccountsChanged = funtypes.Static<typeof WindowMessageSignerAccountsChanged>
const WindowMessageSignerAccountsChanged = funtypes.ReadonlyObject({
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

type UpdateRPCList = funtypes.Static<typeof UpdateRPCList>
const UpdateRPCList = funtypes.ReadonlyObject({
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

type ChangeChainRequest = funtypes.Static<typeof ChangeChainRequest>
const ChangeChainRequest = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_ChangeChainRequest'),
	data: PendingChainChangeConfirmationPromise,
})

type SettingsUpdated = funtypes.Static<typeof SettingsUpdated>
const SettingsUpdated = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_settingsUpdated'),
	data: Settings
})

type PartiallyParsedSimulateExecutionReply = funtypes.Static<typeof PartiallyParsedSimulateExecutionReply>
const PartiallyParsedSimulateExecutionReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateExecutionReply'),
	data: funtypes.Unknown,
}).asReadonly()

export type GovernanceVoteInputParameters = funtypes.Static<typeof GovernanceVoteInputParameters>
export const GovernanceVoteInputParameters = funtypes.ReadonlyObject({
	proposalId: EthereumQuantity,
	support: funtypes.Union(funtypes.Boolean, EthereumQuantity),
	reason: funtypes.Union(funtypes.Undefined, funtypes.String),
	params: funtypes.Union(funtypes.Undefined, EthereumData),
	signature: funtypes.Union(funtypes.Undefined, EthereumData),
	voter: funtypes.Union(funtypes.Undefined, EthereumAddress),
})

export type SimulateExecutionReplyData = funtypes.Static<typeof SimulateExecutionReplyData>
export const SimulateExecutionReplyData = funtypes.Union(
	funtypes.ReadonlyObject({
		success: funtypes.Literal(false),
		errorType: funtypes.Literal('Other'),
		transactionOrMessageIdentifier: EthereumQuantity,
		errorMessage: funtypes.String,
	}),
	funtypes.ReadonlyObject({
		success: funtypes.Literal(false),
		errorType: funtypes.Literal('MissingAbi'),
		transactionOrMessageIdentifier: EthereumQuantity,
		errorMessage: funtypes.String,
		errorAddressBookEntry: AddressBookEntry,
	}),
	funtypes.ReadonlyObject({
		success: funtypes.Literal(true),
		transactionOrMessageIdentifier: EthereumQuantity,
		result: funtypes.ReadonlyObject({
			namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
			addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
			visualizedSimulationState: VisualizedSimulationState,
			tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
			simulationState: funtypes.Union(SimulationState),
		})
	})
)

export type SimulateExecutionReply = funtypes.Static<typeof SimulateExecutionReply>
export const SimulateExecutionReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateExecutionReply'),
	data: SimulateExecutionReplyData
}).asReadonly()

export type SimulateGovernanceContractExecution = funtypes.Static<typeof SimulateGovernanceContractExecution>
export const SimulateGovernanceContractExecution = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGovernanceContractExecution'),
	data: funtypes.ReadonlyObject({ transactionIdentifier: EthereumQuantity })
})

type SimulateGnosisSafeTransaction = funtypes.Static<typeof SimulateGnosisSafeTransaction>
const SimulateGnosisSafeTransaction = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_simulateGnosisSafeTransaction'),
	data: funtypes.ReadonlyObject({
		gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx,
	})
})

type SettingsOpenedReply = funtypes.Static<typeof SettingsOpenedReply>
const SettingsOpenedReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSettingsReply'),
	data: funtypes.ReadonlyObject({
		useTabsInsteadOfPopup: funtypes.Boolean,
		metamaskCompatibilityMode: funtypes.Boolean,
		activeRpcNetwork: RpcNetwork,
		rpcEntries: RpcEntries,
	})
}).asReadonly()

export type ChangeAddOrModifyAddressWindowState = funtypes.Static<typeof ChangeAddOrModifyAddressWindowState>
export const ChangeAddOrModifyAddressWindowState = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changeAddOrModifyAddressWindowState'),
	data: funtypes.ReadonlyObject({
		windowStateId: funtypes.String,
		newState: ModifyAddressWindowState,
	})
})

export type RetrieveWebsiteAccessFilter = funtypes.Static<typeof RetrieveWebsiteAccessFilter>
export const RetrieveWebsiteAccessFilter = funtypes.ReadonlyObject({
	query: funtypes.String,
}).asReadonly()

export type RetrieveWebsiteAccess = funtypes.Static<typeof RetrieveWebsiteAccess>
export const RetrieveWebsiteAccess = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_retrieveWebsiteAccess'),
	data: RetrieveWebsiteAccessFilter,
}).asReadonly()

type RetrieveWebsiteAccessReply = funtypes.Static<typeof RetrieveWebsiteAccessReply>
const RetrieveWebsiteAccessReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_retrieveWebsiteAccessReply'),
	data: funtypes.ReadonlyObject({
		websiteAccess: WebsiteAccessArray,
		addressAccessMetadata: AddressBookEntries
	})
}).asReadonly()

type PopupAddOrModifyAddressWindowStateInfomation = funtypes.Static<typeof PopupAddOrModifyAddressWindowStateInfomation>
const PopupAddOrModifyAddressWindowStateInfomation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_addOrModifyAddressWindowStateInformation'),
	data: funtypes.ReadonlyObject({
		windowStateId: funtypes.String,
		errorState: funtypes.Union(funtypes.ReadonlyObject({ message: funtypes.String, blockEditing: funtypes.Boolean }), funtypes.Undefined),
		identifiedAddress: funtypes.Union(funtypes.Undefined, AddressBookEntry)
	})
})

export type FetchAbiAndNameFromBlockExplorer = funtypes.Static<typeof FetchAbiAndNameFromBlockExplorer>
export const FetchAbiAndNameFromBlockExplorer = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_fetchAbiAndNameFromBlockExplorer'),
	data: funtypes.ReadonlyObject({
		windowStateId: funtypes.String,
		address: EthereumAddress,
		chainId: ChainIdWithUniversal,
	})
}).asReadonly()

type FetchAbiAndNameFromBlockExplorerReply = funtypes.Static<typeof FetchAbiAndNameFromBlockExplorerReply>
const FetchAbiAndNameFromBlockExplorerReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_fetchAbiAndNameFromBlockExplorerReply'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			windowStateId: funtypes.String,
			success: funtypes.Literal(true),
			address: EthereumAddress,
			abi: funtypes.Union(funtypes.String, funtypes.Undefined),
			contractName: funtypes.String,
		}),
		funtypes.ReadonlyObject({
			windowStateId: funtypes.String,
			address: EthereumAddress,
			success: funtypes.Literal(false),
			error: funtypes.String,
		}),
	)
}).asReadonly()

export type OpenWebPage = funtypes.Static<typeof OpenWebPage>
export const OpenWebPage = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_openWebPage'),
	data: funtypes.ReadonlyObject({
		url: funtypes.String,
		websiteSocket: WebsiteSocket
	})
}).asReadonly()

export type DisableInterceptor = funtypes.Static<typeof DisableInterceptor>
export const DisableInterceptor = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_setDisableInterceptor'),
	data: funtypes.ReadonlyObject({
		interceptorDisabled: funtypes.Boolean,
		website: Website,
	})
}).asReadonly()

type DisableInterceptorReply = funtypes.Static<typeof DisableInterceptorReply>
const DisableInterceptorReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_setDisableInterceptorReply'),
	data: funtypes.ReadonlyObject({
		interceptorDisabled: funtypes.Boolean,
		website: Website,
	})
}).asReadonly()

export type SetEnsNameForHash = funtypes.Static<typeof SetEnsNameForHash>
export const SetEnsNameForHash = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_setEnsNameForHash'),
	data: funtypes.ReadonlyObject({
		type: funtypes.Union(funtypes.Literal('nameHash'), funtypes.Literal('labelHash')),
		nameHash: EthereumBytes32,
		name: funtypes.String
	})
}).asReadonly()

export type ForceSetGasLimitForTransaction = funtypes.Static<typeof ForceSetGasLimitForTransaction>
export const ForceSetGasLimitForTransaction = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_forceSetGasLimitForTransaction'),
	data: funtypes.ReadonlyObject({
		gasLimit: EthereumQuantity,
		transactionIdentifier: EthereumQuantity
	})
}).asReadonly()

export type ChangePreSimulationBlockTimeManipulation = funtypes.Static<typeof ChangePreSimulationBlockTimeManipulation>
export const ChangePreSimulationBlockTimeManipulation = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_changePreSimulationBlockTimeManipulation'),
	data: funtypes.ReadonlyObject({
		blockTimeManipulation: BlockTimeManipulation
	})
}).asReadonly()

export type SetTransactionOrMessageBlockTimeManipulator = funtypes.Static<typeof SetTransactionOrMessageBlockTimeManipulator>
export const SetTransactionOrMessageBlockTimeManipulator = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_setTransactionOrMessageBlockTimeManipulator'),
	data: funtypes.ReadonlyObject({
		transactionOrMessageIdentifier: TransactionOrMessageIdentifier,
		blockTimeManipulation: BlockTimeManipulationWithNoDelay
	})
}).asReadonly()

export type PopupMessage = funtypes.Static<typeof PopupMessage>
export const PopupMessage = funtypes.Union(
	PopupMessageReplyRequests,
	TransactionConfirmation,
	RemoveTransaction,
	ResetSimulation,
	RefreshSimulation,
	ModifyMakeMeRich,
	ChangeActiveAddress,
	ChangePage,
	RequestAccountsFromSigner,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshConfirmTransactionDialogSimulation') }),
	RefreshConfirmTransactionMetadata,
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
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_changeChainReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_interceptorAccessReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_confirmTransactionReadyAndListening') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestNewHomeData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_refreshHomeData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_openSettings') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_clearUnexpectedError') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_import_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_get_export_settings') }),
	SimulateGovernanceContractExecution,
	SimulateGnosisSafeTransaction,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSettings') }),
	ChangeSettings,
	SetRpcList,
	ChangeAddOrModifyAddressWindowState,
	FetchAbiAndNameFromBlockExplorer,
	OpenWebPage,
	DisableInterceptor,
	SetEnsNameForHash,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_openWebsiteAccess') }),
	RetrieveWebsiteAccess,
	BlockOrAllowExternalRequests,
	AllowOrPreventAddressAccessForWebsite,
	RemoveWebsiteAddressAccess,
	RemoveWebsiteAccess,
	ForceSetGasLimitForTransaction,
	ChangePreSimulationBlockTimeManipulation,
	SetTransactionOrMessageBlockTimeManipulator,
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
	UpdateConfirmTransactionDialogPartial,
	UpdateConfirmTransactionDialogPendingTransactions,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_initiate_export_settings'), data: funtypes.ReadonlyObject({ fileContents: funtypes.String }) }),
	ImportSettingsReply,
	ActiveSigningAddressChanged,
	UpdateRPCList,
	SimulationUpdateStartedOrEnded,
	PartialUpdateHomePage,
	PartiallyParsedSimulateExecutionReply,
	SettingsOpenedReply,
	PopupAddOrModifyAddressWindowStateInfomation,
	FetchAbiAndNameFromBlockExplorerReply,
	DisableInterceptorReply,
	UnexpectedErrorOccured,
	RetrieveWebsiteAccessReply,
)
