import * as funtypes from 'funtypes'
import { AddressBookEntries, AddressBookEntry, AddressInfo, AddressInfoEntry } from './user-interface-types.js'
import { EIP2612Message, EthereumAddress, EthereumQuantity, EthereumUnsignedTransaction, Permit2 } from './wire-types.js'
import { SimResults, TokenPriceEstimate } from './visualizer-types.js'

export type MessageMethodAndParams = funtypes.Static<typeof MessageMethodAndParams>
export const MessageMethodAndParams = funtypes.Union(
	funtypes.Object({
		method: funtypes.String,
		params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
	}).asReadonly(),
	funtypes.Object({ method: funtypes.String }).asReadonly()
)

export type InterceptedRequest = funtypes.Static<typeof InterceptedRequest>
export const InterceptedRequest = funtypes.Intersect(
	funtypes.Object({
		interceptorRequest: funtypes.Boolean,
		usingInterceptorWithoutSigner: funtypes.Boolean,
		options: MessageMethodAndParams,
	}).asReadonly(),
	funtypes.Partial({
		requestId: funtypes.Number,
	}).asReadonly()
)
export type ProviderMessage = InterceptedRequest

export type InterceptedRequestForward = funtypes.Static<typeof InterceptedRequestForward>
export const InterceptedRequestForward = funtypes.Intersect(
	funtypes.Object({
		interceptorApproved: funtypes.Boolean,
		options: MessageMethodAndParams,
	}).asReadonly(),
	funtypes.Union(
		funtypes.Object({
			result: funtypes.Unknown,
		}),
		funtypes.Object({
			error: funtypes.Object({
				code: funtypes.Number,
				message: funtypes.String
			}).asReadonly(),
		}).asReadonly(),
		funtypes.Object({ })
	),
	funtypes.Partial({
		subscription: funtypes.String,
		usingInterceptorWithoutSigner: funtypes.Boolean,
		requestId: funtypes.Number}).asReadonly()
)

export type TransactionConfirmation = funtypes.Static<typeof TransactionConfirmation>
export const TransactionConfirmation = funtypes.Object({
	method: funtypes.Literal('popup_confirmDialog'),
	options: funtypes.Object({
		requestId: funtypes.Number,
		accept: funtypes.Boolean
	})
}).asReadonly()

export type PersonalSign = funtypes.Static<typeof PersonalSign>
export const PersonalSign = funtypes.Object({
	method: funtypes.Literal('popup_personalSign'),
	options: funtypes.Object({
		requestId: funtypes.Number,
		accept: funtypes.Boolean
	})
}).asReadonly()

export type InterceptorAccess = funtypes.Static<typeof InterceptorAccess>
export const InterceptorAccess = funtypes.Object({
	method: funtypes.Literal('popup_interceptorAccess'),
	options: funtypes.Object({
		accept: funtypes.Boolean,
		origin: funtypes.String,
		requestAccessToAddress: funtypes.Union(EthereumAddress, funtypes.Undefined),
	})
}).asReadonly()

export type ChangeActiveAddress = funtypes.Static<typeof ChangeActiveAddress>
export const ChangeActiveAddress = funtypes.Object({
	method: funtypes.Literal('popup_changeActiveAddress'),
	options: funtypes.Union(EthereumAddress, funtypes.Literal('signer')),
}).asReadonly()

export type ChangeMakeMeRich = funtypes.Static<typeof ChangeMakeMeRich>
export const ChangeMakeMeRich = funtypes.Object({
	method: funtypes.Literal('popup_changeMakeMeRich'),
	options: funtypes.Boolean
}).asReadonly()

export type AddressBookCategory = funtypes.Static<typeof AddressBookCategory>
export const AddressBookCategory = funtypes.Union(
	funtypes.Literal('My Active Addresses'),
	funtypes.Literal('My Contacts'),
	funtypes.Literal('Tokens'),
	funtypes.Literal('Non Fungible Tokens'),
	funtypes.Literal('Other Contracts')
)

export type ChangeAddressInfos = funtypes.Static<typeof ChangeAddressInfos>
export const ChangeAddressInfos = funtypes.Object({
	method: funtypes.Literal('popup_changeAddressInfos'),
	options: funtypes.ReadonlyArray(AddressInfo)
}).asReadonly()

export type RemoveAddressBookEntry = funtypes.Static<typeof RemoveAddressBookEntry>
export const RemoveAddressBookEntry = funtypes.Object({
	method: funtypes.Literal('popup_removeAddressBookEntry'),
	options: funtypes.Object({
		address: EthereumAddress,
		addressBookCategory: AddressBookCategory,
	})
}).asReadonly()

export type AddOrModifyAddresInfo = funtypes.Static<typeof AddOrModifyAddresInfo>
export const AddOrModifyAddresInfo = funtypes.Object({
	method: funtypes.Literal('popup_addOrModifyAddressBookEntry'),
	options: funtypes.ReadonlyArray(AddressBookEntry)
}).asReadonly()

export type ChangePage = funtypes.Static<typeof ChangePage>
export const ChangePage = funtypes.Object({
	method: funtypes.Literal('popup_changePage'),
	options: funtypes.Number
}).asReadonly()

export type RequestAccountsFromSigner = funtypes.Static<typeof RequestAccountsFromSigner>
export const RequestAccountsFromSigner = funtypes.Object({
	method: funtypes.Literal('popup_requestAccountsFromSigner'),
	options: funtypes.Boolean
}).asReadonly()

export type EnableSimulationMode = funtypes.Static<typeof EnableSimulationMode>
export const EnableSimulationMode = funtypes.Object({
	method: funtypes.Literal('popup_enableSimulationMode'),
	options: funtypes.Boolean
}).asReadonly()

export type RemoveTransaction = funtypes.Static<typeof RemoveTransaction>
export const RemoveTransaction = funtypes.Object({
	method: funtypes.Literal('popup_removeTransaction'),
	options: EthereumQuantity,
}).asReadonly()

export type ResetSimulation = funtypes.Static<typeof ResetSimulation>
export const ResetSimulation = funtypes.Object({
	method: funtypes.Literal('popup_resetSimulation')
}).asReadonly()

export type RefreshSimulation = funtypes.Static<typeof RefreshSimulation>
export const RefreshSimulation = funtypes.Object({
	method: funtypes.Literal('popup_refreshSimulation')
}).asReadonly()

export type RefreshConfirmTransactionDialogSimulation = funtypes.Static<typeof RefreshConfirmTransactionDialogSimulation>
export const RefreshConfirmTransactionDialogSimulation = funtypes.Object({
	method: funtypes.Literal('popup_refreshConfirmTransactionDialogSimulation')
}).asReadonly()

export type ChangeInterceptorAccess = funtypes.Static<typeof ChangeInterceptorAccess>
export const ChangeInterceptorAccess = funtypes.Object({
	method: funtypes.Literal('popup_changeInterceptorAccess'),
	options: funtypes.ReadonlyArray(
		funtypes.Object({
			origin: funtypes.String,
			originIcon: funtypes.Union(funtypes.String, funtypes.Undefined),
			access: funtypes.Boolean,
			addressAccess: funtypes.Union(
				funtypes.ReadonlyArray(funtypes.Object( {
					address: EthereumAddress,
					access: funtypes.Boolean,
				} ))
			, funtypes.Undefined),
		})
	)
}).asReadonly()

export type ChangeActiveChain = funtypes.Static<typeof ChangeActiveChain>
export const ChangeActiveChain = funtypes.Object({
	method: funtypes.Literal('popup_changeActiveChain'),
	options: EthereumQuantity,
}).asReadonly()

export type ChainChangeConfirmation = funtypes.Static<typeof ChainChangeConfirmation>
export const ChainChangeConfirmation = funtypes.Object({
	method: funtypes.Literal('popup_changeChainDialog'),
	options: funtypes.Object({
		requestId: funtypes.Number,
		accept: funtypes.Boolean,
	})
}).asReadonly()

export type SignerChainChangeConfirmation = funtypes.Static<typeof SignerChainChangeConfirmation>
export const SignerChainChangeConfirmation = funtypes.Object({
	method: funtypes.Literal('popup_signerChangeChainDialog'),
	options: funtypes.Object({
		chainId: EthereumQuantity,
		accept: funtypes.Boolean,
	})
}).asReadonly()

export type SignerName = funtypes.Static<typeof SignerName>
export const SignerName = funtypes.Union(
	funtypes.Literal('NoSigner'),
	funtypes.Literal('NotRecognizedSigner'),
	funtypes.Literal('MetaMask'),
	funtypes.Literal('Brave'),
)

export type ConnectedToSigner = funtypes.Static<typeof ConnectedToSigner>
export const ConnectedToSigner = funtypes.Object({
	method: funtypes.Literal('connected_to_signer'),
	params: funtypes.Tuple(SignerName),
}).asReadonly()

export type WalletSwitchEthereumChainReply = funtypes.Static<typeof WalletSwitchEthereumChainReply>
export const WalletSwitchEthereumChainReply = funtypes.Object({
	method: funtypes.Literal('wallet_switchEthereumChain_reply'),
	params: funtypes.Tuple(funtypes.Object({
		accept: funtypes.Boolean,
		chainId: EthereumQuantity,
	}))
}).asReadonly()

export type ReviewNotification = funtypes.Static<typeof ReviewNotification>
export const ReviewNotification = funtypes.Object({
	method: funtypes.Literal('popup_reviewNotification'),
	options: funtypes.Object({
		origin: funtypes.String,
		requestAccessToAddress: funtypes.Union(EthereumAddress, funtypes.Undefined),
	})
}).asReadonly()

export type RejectNotification = funtypes.Static<typeof RejectNotification>
export const RejectNotification = funtypes.Object({
	method: funtypes.Literal('popup_rejectNotification'),
	options: funtypes.Object({
		origin: funtypes.String,
		requestAccessToAddress: funtypes.Union(EthereumAddress, funtypes.Undefined),
		removeOnly: funtypes.Boolean,
	})
}).asReadonly()

export type GetAddressBookDataFilter = funtypes.Static<typeof GetAddressBookDataFilter>
export const GetAddressBookDataFilter = funtypes.Intersect(
	funtypes.Object({
		filter: AddressBookCategory,
		startIndex: funtypes.Number,
		maxIndex: funtypes.Number,
	}).asReadonly(),
	funtypes.Partial({
		searchString: funtypes.String,
	}).asReadonly()
)

export type GetAddressBookData = funtypes.Static<typeof GetAddressBookData>
export const GetAddressBookData = funtypes.Object({
	method: funtypes.Literal('popup_getAddressBookData'),
	options: GetAddressBookDataFilter,
}).asReadonly()

export type OpenAddressBook = funtypes.Static<typeof OpenAddressBook>
export const OpenAddressBook = funtypes.Object({
	method: funtypes.Literal('popup_openAddressBook'),
}).asReadonly()

export type GetAddressBookDataReplyData = funtypes.Static<typeof GetAddressBookDataReplyData>
export const GetAddressBookDataReplyData = funtypes.Object({
	options: GetAddressBookDataFilter,
	entries: AddressBookEntries,
	maxDataLength: funtypes.Number,
}).asReadonly()

export type GetAddressBookDataReply = funtypes.Static<typeof GetAddressBookDataReply>
export const GetAddressBookDataReply = funtypes.Object({
	message: funtypes.Literal('popup_getAddressBookData'),
	data: GetAddressBookDataReplyData,
}).asReadonly()

export type PopupMessage = funtypes.Static<typeof PopupMessage>
export const PopupMessage = funtypes.Union(
	ChangeAddressInfos,
	ChangeMakeMeRich,
	ChangeActiveAddress,
	TransactionConfirmation,
	ChangePage,
	RequestAccountsFromSigner,
	RemoveTransaction,
	ResetSimulation,
	RefreshSimulation,
	RefreshConfirmTransactionDialogSimulation,
	PersonalSign,
	InterceptorAccess,
	ChangeInterceptorAccess,
	ChangeActiveChain,
	ChainChangeConfirmation,
	SignerChainChangeConfirmation,
	EnableSimulationMode,
	RejectNotification,
	ReviewNotification,
	ConnectedToSigner,
	AddOrModifyAddresInfo,
	GetAddressBookData,
	RemoveAddressBookEntry,
	OpenAddressBook,
	funtypes.Object({ method: funtypes.Literal('popup_personalSignReadyAndListening') }),
	funtypes.Object({ method: funtypes.Literal('popup_changeChainReadyAndListening') }),
	funtypes.Object({ method: funtypes.Literal('popup_interceptorAccessReadyAndListening') }),
)

export const MessageToPopupSimple = funtypes.Object({
	message: funtypes.Union(
		funtypes.Literal('popup_chain_update'),
		funtypes.Literal('popup_started_simulation_update'),
		funtypes.Literal('popup_simulation_state_changed'),
		funtypes.Literal('popup_confirm_transaction_simulation_started'),
		funtypes.Literal('popup_new_block_arrived'),
		funtypes.Literal('popup_accounts_update'),
		funtypes.Literal('popup_websiteIconChanged'),
		funtypes.Literal('popup_address_infos_changed'),
		funtypes.Literal('popup_interceptor_access_changed'),
		funtypes.Literal('popup_notification_removed'),
		funtypes.Literal('popup_signer_name_changed'),
		funtypes.Literal('popup_accounts_update'),
		funtypes.Literal('popup_websiteAccess_changed'),
		funtypes.Literal('popup_notification_added'),
		funtypes.Literal('popup_notification_added'),
	)
}).asReadonly()

export type PersonalSignRequest = funtypes.Static<typeof PersonalSignRequest>
export const PersonalSignRequest = funtypes.Object({
	message: funtypes.Literal('popup_personal_sign_request'),
	data: funtypes.Intersect(
		funtypes.Object({
			activeAddress: EthereumAddress,
			requestId: funtypes.Number,
			simulationMode: funtypes.Boolean,
			account: AddressBookEntry,
			method: funtypes.Union(
				funtypes.Literal('personal_sign'),
				funtypes.Literal('eth_signTypedData'),
				funtypes.Literal('eth_signTypedData_v1'),
				funtypes.Literal('eth_signTypedData_v2'),
				funtypes.Literal('eth_signTypedData_v3'),
				funtypes.Literal('eth_signTypedData_v4')
			),
		}),
		funtypes.Object({
			type: funtypes.Literal('NotParsed'),
			message: funtypes.String,
		}).Or(funtypes.Object({
			type: funtypes.Literal('Permit'),
			message: EIP2612Message,
			addressBookEntries: funtypes.Object({
				owner: AddressBookEntry,
				spender: AddressBookEntry,
				verifyingContract: AddressBookEntry,
			}),
		})).Or(funtypes.Object({
			type: funtypes.Literal('Permit2'),
			message: Permit2,
			addressBookEntries: funtypes.Object({
				token: AddressBookEntry,
				spender: AddressBookEntry,
				verifyingContract: AddressBookEntry,
			}),
		}))
	)
})

export type ChangeChainRequest = funtypes.Static<typeof ChangeChainRequest>
export const ChangeChainRequest = funtypes.Object({
	message: funtypes.Literal('popup_ChangeChainRequest'),
	data: funtypes.Object({
		requestId: funtypes.Number,
		simulationMode: funtypes.Boolean,
		chainId: EthereumQuantity,
		origin: funtypes.String,
		icon: funtypes.Union(funtypes.String, funtypes.Undefined),
	})
})

export type InterceptorAccessDialog = funtypes.Static<typeof InterceptorAccessDialog>
export const InterceptorAccessDialog = funtypes.Object({
	message: funtypes.Literal('popup_interceptorAccessDialog'),
	data: funtypes.Object({
		origin: funtypes.String,
		icon: funtypes.Union(funtypes.String, funtypes.Undefined),
		requestAccessToAddress: funtypes.Union(AddressInfoEntry, funtypes.Undefined),
		associatedAddresses: funtypes.ReadonlyArray(AddressInfoEntry),
	})
})

export type ConfirmTransactionSimulationStateChanged = funtypes.Static<typeof ConfirmTransactionSimulationStateChanged>
export const ConfirmTransactionSimulationStateChanged = funtypes.Object({
	message: funtypes.Literal('popup_confirm_transaction_simulation_state_changed'),
	data: funtypes.Object({
		requestId: funtypes.Number,
		transactionToSimulate: EthereumUnsignedTransaction,
		simulationMode: funtypes.Boolean,
		simulationState: funtypes.Boolean,
		isComputingSimulation: funtypes.Boolean,
		visualizerResults: SimResults,
		addressBookEntries: AddressBookEntries,
		tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
		activeAddress: EthereumAddress,
	})
})

export type MessageToPopup = funtypes.Static<typeof MessageToPopup>
export const MessageToPopup = funtypes.Union(
	MessageToPopupSimple,
	GetAddressBookDataReply,
	PersonalSignRequest,
	ChangeChainRequest,
	InterceptorAccessDialog,
	ConfirmTransactionSimulationStateChanged,
)

export type HandleSimulationModeReturnValue = {
	result: unknown,
} | {
	error: {
		code: number,
		message: string,
	}
} | {
	forward: true,
}

export type AddressBookTabIdSetting = funtypes.Static<typeof AddressBookTabIdSetting>
export const AddressBookTabIdSetting = funtypes.Object({
	addressbookTabId: funtypes.Number,
}).asReadonly()
