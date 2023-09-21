import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBytes32, LiteralConverterParserFactory, NonHexBigInt } from './wire-types.js'
import { QUARANTINE_CODE } from '../simulation/protectors/quarantine-codes.js'
import { EthereumInput } from './wire-types.js'
import { EnrichedEIP712 } from '../utils/eip712Parsing.js'
import { RpcNetwork } from './visualizer-types.js'
import { InterceptedRequest } from '../utils/requests.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from './JsonRpc-types.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { Website } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'

export type EIP2612Message = funtypes.Static<typeof EIP2612Message>
export const EIP2612Message = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		EIP712Domain: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('name'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('version'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('chainId'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('verifyingContract'),
				type: funtypes.Literal('address'),
			}),
		),
		Permit: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('owner'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('spender'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('value'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('nonce'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('deadline'),
				type: funtypes.Literal('uint256'),
			}),
		),
	}),
	primaryType: funtypes.Literal('Permit'),
	domain: funtypes.ReadonlyObject({
		name: funtypes.String,
		version: NonHexBigInt,
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	message: funtypes.ReadonlyObject({
		owner: EthereumAddress,
		spender: EthereumAddress,
		value: NonHexBigInt,
		nonce: funtypes.Number,
		deadline: funtypes.Number,
	}),
})

export type Permit2 = funtypes.Static<typeof Permit2>
export const Permit2 = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitSingle: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('details'),
				type: funtypes.Literal('PermitDetails'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('spender'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('sigDeadline'),
				type: funtypes.Literal('uint256'),
			}),
		),
		PermitDetails: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('token'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('amount'),
				type: funtypes.Literal('uint160'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('expiration'),
				type: funtypes.Literal('uint48'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('nonce'),
				type: funtypes.Literal('uint48'),
			}),
		),
		EIP712Domain: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('name'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('chainId'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('verifyingContract'),
				type: funtypes.Literal('address'),
			}),
		)
	}),
	domain: funtypes.ReadonlyObject({
		name: funtypes.Literal('Permit2'),
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	primaryType: funtypes.Literal('PermitSingle'),
	message: funtypes.ReadonlyObject({
		details: funtypes.ReadonlyObject({
			token: EthereumAddress,
			amount: NonHexBigInt,
			expiration: NonHexBigInt,
			nonce: NonHexBigInt,
		}),
		spender: EthereumAddress,
		sigDeadline: NonHexBigInt,
	})
})

export type SeaPortItemType = funtypes.Static<typeof SeaPortItemType>
export const SeaPortItemType = funtypes.Union(
	funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'NATIVE' as const)),
	funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'ERC20' as const)),
	funtypes.Literal('2').withParser(LiteralConverterParserFactory('2', 'ERC721' as const)),
	funtypes.Literal('3').withParser(LiteralConverterParserFactory('3', 'ERC1155' as const)),
	funtypes.Literal('4').withParser(LiteralConverterParserFactory('4', 'ERC721_WITH_CRITERIA' as const)),
	funtypes.Literal('5').withParser(LiteralConverterParserFactory('5', 'ERC1155_WITH_CRITERIA' as const)),
)

export type SeaPortOrderType = funtypes.Static<typeof SeaPortOrderType>
export const SeaPortOrderType = funtypes.Union(
	funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'FULL_OPEN' as const)),
	funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'PARTIAL_OPEN' as const)),
	funtypes.Literal('2').withParser(LiteralConverterParserFactory('2', 'FULL_RESTRICTED' as const)),
	funtypes.Literal('3').withParser(LiteralConverterParserFactory('3', 'PARTIAL_RESTRICTED' as const)),
	funtypes.Literal('4').withParser(LiteralConverterParserFactory('4', 'CONTRACT' as const)),
)

export type SeaPortSingleOffer = funtypes.Static<typeof SeaPortSingleOffer>
export const SeaPortSingleOffer = funtypes.Union(
	funtypes.ReadonlyObject({
		itemType: SeaPortItemType,
		token: EthereumAddress,
		identifierOrCriteria: NonHexBigInt,
		startAmount: NonHexBigInt,
		endAmount: NonHexBigInt
	})
)

export type SeaPortSingleConsideration = funtypes.Static<typeof SeaPortSingleConsideration>
export const SeaPortSingleConsideration = funtypes.ReadonlyObject({
	itemType: SeaPortItemType,
	token: EthereumAddress,
	identifierOrCriteria: NonHexBigInt,
	startAmount: NonHexBigInt,
	endAmount: NonHexBigInt,
	recipient: EthereumAddress
})

export type OpenSeaOrderMessage = funtypes.Static<typeof OpenSeaOrderMessage>
export const OpenSeaOrderMessage = funtypes.ReadonlyObject({
    offerer: EthereumAddress,
    offer: funtypes.ReadonlyArray(SeaPortSingleOffer),
    consideration: funtypes.ReadonlyArray(SeaPortSingleConsideration),
    startTime: NonHexBigInt,
    endTime: NonHexBigInt,
    orderType: SeaPortOrderType,
    zone: EthereumAddress,
    zoneHash: EthereumBytes32,
    salt: NonHexBigInt,
    conduitKey: EthereumBytes32,
    totalOriginalConsiderationItems: NonHexBigInt,
    counter: NonHexBigInt,
})

export type OpenSeaOrder = funtypes.Static<typeof OpenSeaOrder>
export const OpenSeaOrder = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		EIP712Domain: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('name'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('version'),
				type: funtypes.Literal('string'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('chainId'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('verifyingContract'),
				type: funtypes.Literal('address'),
			}),
		),
		OrderComponents: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('offerer'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('zone'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('offer'),
				type: funtypes.Literal('OfferItem[]'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('consideration'),
				type: funtypes.Literal('ConsiderationItem[]'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('orderType'),
				type: funtypes.Literal('uint8'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('startTime'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('endTime'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('zoneHash'),
				type: funtypes.Literal('bytes32'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('salt'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('conduitKey'),
				type: funtypes.Literal('bytes32'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('counter'),
				type: funtypes.Literal('uint256'),
			})
		),
		OfferItem: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('itemType'),
				type: funtypes.Literal('uint8'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('token'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('identifierOrCriteria'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('startAmount'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('endAmount'),
				type: funtypes.Literal('uint256'),
			}),
		),
		ConsiderationItem: funtypes.Tuple(
			funtypes.ReadonlyObject({
				name: funtypes.Literal('itemType'),
				type: funtypes.Literal('uint8'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('token'),
				type: funtypes.Literal('address'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('identifierOrCriteria'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('startAmount'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('endAmount'),
				type: funtypes.Literal('uint256'),
			}),
			funtypes.ReadonlyObject({
				name: funtypes.Literal('recipient'),
				type: funtypes.Literal('address'),
			})
		)
	}),
	primaryType: funtypes.Literal('OrderComponents'),
	domain: funtypes.ReadonlyObject({
		name: funtypes.Literal('Seaport'),
		version: funtypes.Literal('1.5'),
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	message: OpenSeaOrderMessage
})

export type SeaPortSingleOfferWithAddressBookEntries  = funtypes.Static<typeof SeaPortSingleOfferWithAddressBookEntries >
export const SeaPortSingleOfferWithAddressBookEntries  = funtypes.Union(
	funtypes.ReadonlyObject({
		itemType: SeaPortItemType,
		token: AddressBookEntry,
		identifierOrCriteria: NonHexBigInt,
		startAmount: NonHexBigInt,
		endAmount: NonHexBigInt
	})
)

export type SeaPortSingleConsiderationWithAddressBookEntries  = funtypes.Static<typeof SeaPortSingleConsiderationWithAddressBookEntries >
export const SeaPortSingleConsiderationWithAddressBookEntries  = funtypes.ReadonlyObject({
	itemType: SeaPortItemType,
	token: AddressBookEntry,
	identifierOrCriteria: NonHexBigInt,
	startAmount: NonHexBigInt,
	endAmount: NonHexBigInt,
	recipient: AddressBookEntry
})

export type OpenSeaOrderMessageWithAddressBookEntries = funtypes.Static<typeof OpenSeaOrderMessageWithAddressBookEntries>
export const OpenSeaOrderMessageWithAddressBookEntries = funtypes.ReadonlyObject({
    offerer: AddressBookEntry,
    offer: funtypes.ReadonlyArray(SeaPortSingleOfferWithAddressBookEntries),
    consideration: funtypes.ReadonlyArray(SeaPortSingleConsiderationWithAddressBookEntries),
    startTime: NonHexBigInt,
    endTime: NonHexBigInt,
    orderType: SeaPortOrderType,
    zone: AddressBookEntry,
    zoneHash: EthereumBytes32,
    salt: NonHexBigInt,
    conduitKey: EthereumBytes32,
    totalOriginalConsiderationItems: NonHexBigInt,
    counter: NonHexBigInt,
})

export type PersonalSignRequestBase = funtypes.Static<typeof PersonalSignRequestBase>
export const PersonalSignRequestBase = funtypes.Intersect(
	funtypes.ReadonlyObject({
		activeAddress: AddressBookEntry,
		rpcNetwork: RpcNetwork,
		request: InterceptedRequest,
		simulationMode: funtypes.Boolean,
		signerName: SignerName,
		quarantineCodes: funtypes.ReadonlyArray(QUARANTINE_CODE),
		quarantine: funtypes.Boolean,
		account: AddressBookEntry,
		website: Website,
	}),
)

export type VisualizedPersonalSignRequestNotParsed = funtypes.Static<typeof VisualizedPersonalSignRequest>
export const VisualizedPersonalSignRequestNotParsed = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: funtypes.Union(PersonalSignParams, OldSignTypedDataParams),
		type: funtypes.Literal('NotParsed'),
		message: funtypes.String,
	})
)

export type VisualizedPersonalSignRequestEIP712 = funtypes.Static<typeof VisualizedPersonalSignRequestEIP712>
export const VisualizedPersonalSignRequestEIP712 = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: SignTypedDataParams,
		type: funtypes.Literal('EIP712'),
		message: EnrichedEIP712,
	})
)

export type VisualizedPersonalSignRequestPermit = funtypes.Static<typeof VisualizedPersonalSignRequestPermit>
export const VisualizedPersonalSignRequestPermit = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: SignTypedDataParams,
		type: funtypes.Literal('Permit'),
		message: EIP2612Message,
		addressBookEntries: funtypes.ReadonlyObject({
			owner: AddressBookEntry,
			spender: AddressBookEntry,
			verifyingContract: AddressBookEntry,
		}),
	})
)

export type VisualizedPersonalSignRequestPermit2 = funtypes.Static<typeof VisualizedPersonalSignRequestPermit2>
export const VisualizedPersonalSignRequestPermit2 = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: SignTypedDataParams,
		type: funtypes.Literal('Permit2'),
		message: Permit2,
		addressBookEntries: funtypes.ReadonlyObject({
			token: AddressBookEntry,
			spender: AddressBookEntry,
			verifyingContract: AddressBookEntry,
		}),
	})
)

export type VisualizedPersonalSignRequestOrderComponents = funtypes.Static<typeof VisualizedPersonalSignRequestOrderComponents>
export const VisualizedPersonalSignRequestOrderComponents = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: SignTypedDataParams,
		type: funtypes.Literal('OrderComponents'),
		message: OpenSeaOrderMessageWithAddressBookEntries,
	})
)

export type SafeTx = funtypes.Static<typeof SafeTx>
export const SafeTx = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		SafeTx: funtypes.Tuple(
            funtypes.ReadonlyObject({ name: funtypes.Literal('to'), type: funtypes.Literal('address') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('value'), type: funtypes.Literal('uint256') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('data'), type: funtypes.Literal('bytes') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('operation'), type: funtypes.Literal('uint8') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('safeTxGas'), type: funtypes.Literal('uint256') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('baseGas'), type: funtypes.Literal('uint256') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('gasPrice'), type: funtypes.Literal('uint256') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('gasToken'), type: funtypes.Literal('address') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('refundReceiver'), type: funtypes.Literal('address') }),
            funtypes.ReadonlyObject({ name: funtypes.Literal('nonce'), type: funtypes.Literal('uint256') })
		),
        EIP712Domain: funtypes.Tuple(
			funtypes.Partial({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') })
		),
    }),
    primaryType: funtypes.Literal('SafeTx'),
    domain: funtypes.Intersect(
		funtypes.Partial({
			chainId: NonHexBigInt,
		}),
		funtypes.ReadonlyObject({
        	verifyingContract: EthereumAddress,
		})
	),
    message: funtypes.ReadonlyObject({
        to: EthereumAddress,
        value: NonHexBigInt,
        data: EthereumInput,
        operation: NonHexBigInt,
        safeTxGas: NonHexBigInt,
        baseGas: NonHexBigInt,
        gasPrice: NonHexBigInt,
        gasToken: EthereumAddress,
        refundReceiver: EthereumAddress,
        nonce: NonHexBigInt,
    })
})

export type VisualizedPersonalSignRequestSafeTx = funtypes.Static<typeof VisualizedPersonalSignRequestSafeTx>
export const VisualizedPersonalSignRequestSafeTx = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		originalParams: SignTypedDataParams,
		type: funtypes.Literal('SafeTx'),
		message: SafeTx,
		addressBookEntries: funtypes.ReadonlyObject({
			gasToken: AddressBookEntry,
			to: AddressBookEntry,
			refundReceiver: AddressBookEntry,
			verifyingContract: AddressBookEntry,
		}),
	})
)

export type VisualizedPersonalSignRequest = funtypes.Static<typeof VisualizedPersonalSignRequest>
export const VisualizedPersonalSignRequest = funtypes.Union(
	VisualizedPersonalSignRequestNotParsed,
	VisualizedPersonalSignRequestEIP712,
	VisualizedPersonalSignRequestPermit,
	VisualizedPersonalSignRequestPermit2,
	VisualizedPersonalSignRequestSafeTx,
	VisualizedPersonalSignRequestOrderComponents,
)

export type PersonalSignRequestIdentifiedEIP712Message = funtypes.Static<typeof PersonalSignRequestIdentifiedEIP712Message>
export const PersonalSignRequestIdentifiedEIP712Message = funtypes.Union(EIP2612Message, Permit2, OpenSeaOrder, SafeTx)
