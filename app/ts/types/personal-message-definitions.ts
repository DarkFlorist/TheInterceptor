import { SafeMessageReview } from './safeReview.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBytes32, EthereumTimestamp, LiteralConverterParserFactory, NonHexBigInt, EthereumInput, EthereumQuantity } from './wire-types.js'
import { RpcNetwork } from './rpc.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { Website } from './websiteAccessTypes.js'
import { SignerName } from './signerTypes.js'
import { EnrichedEIP712, EnrichedEIP712MessageRecord } from './eip721.js'
import { EnrichedEthereumInputData } from './EnrichedEthereumData.js'
import { assertNever } from '../utils/typescript.js'

type EIP2612Message = funtypes.Static<typeof EIP2612Message>
const EIP2612Message = funtypes.ReadonlyObject({
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
		// EIP-712 types the version as a string and it does not have to be an integer, for example "1.0".
		version: funtypes.String,
		chainId: NonHexBigInt,
		verifyingContract: EthereumAddress,
	}),
	// Typed data requests are decoded with every JSON number kept as its source text, so like in the Permit2 types the uint256 fields arrive as decimal strings whether the dapp sent JSON numbers or strings.
	message: funtypes.ReadonlyObject({
		owner: EthereumAddress,
		spender: EthereumAddress,
		value: NonHexBigInt,
		nonce: NonHexBigInt,
		deadline: NonHexBigInt,
	}),
})

const Permit2EIP712DomainTypes = funtypes.ReadonlyTuple(
	funtypes.ReadonlyObject({ name: funtypes.Literal('name'), type: funtypes.Literal('string') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') }),
)

// Every Permit2 message kind shares this domain definition so they are all held to the same domain check.
const Permit2Domain = funtypes.ReadonlyObject({
	name: funtypes.Literal('Permit2'),
	chainId: NonHexBigInt,
	verifyingContract: EthereumAddress,
})

const Permit2DetailsTypes = funtypes.ReadonlyTuple(
	funtypes.ReadonlyObject({ name: funtypes.Literal('token'), type: funtypes.Literal('address') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('amount'), type: funtypes.Literal('uint160') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('expiration'), type: funtypes.Literal('uint48') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('nonce'), type: funtypes.Literal('uint48') }),
)

const Permit2Details = funtypes.ReadonlyObject({
	token: EthereumAddress,
	amount: NonHexBigInt,
	expiration: NonHexBigInt,
	nonce: NonHexBigInt,
})

// Permit2 AllowanceTransfer `PermitSingle`, which grants a time limited allowance for one token.
export type Permit2 = funtypes.Static<typeof Permit2>
export const Permit2 = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitSingle: funtypes.ReadonlyTuple(
			funtypes.ReadonlyObject({ name: funtypes.Literal('details'), type: funtypes.Literal('PermitDetails') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('spender'), type: funtypes.Literal('address') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('sigDeadline'), type: funtypes.Literal('uint256') }),
		),
		PermitDetails: Permit2DetailsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitSingle'),
	message: funtypes.ReadonlyObject({
		details: Permit2Details,
		spender: EthereumAddress,
		sigDeadline: NonHexBigInt,
	})
})

// Permit2 AllowanceTransfer `PermitBatch`, which grants time limited allowances for several tokens at once.
export type Permit2Batch = funtypes.Static<typeof Permit2Batch>
export const Permit2Batch = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitBatch: funtypes.ReadonlyTuple(
			funtypes.ReadonlyObject({ name: funtypes.Literal('details'), type: funtypes.Literal('PermitDetails[]') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('spender'), type: funtypes.Literal('address') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('sigDeadline'), type: funtypes.Literal('uint256') }),
		),
		PermitDetails: Permit2DetailsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitBatch'),
	message: funtypes.ReadonlyObject({
		details: funtypes.ReadonlyArray(Permit2Details),
		spender: EthereumAddress,
		sigDeadline: NonHexBigInt,
	})
})

const Permit2TokenPermissionsTypes = funtypes.ReadonlyTuple(
	funtypes.ReadonlyObject({ name: funtypes.Literal('token'), type: funtypes.Literal('address') }),
	funtypes.ReadonlyObject({ name: funtypes.Literal('amount'), type: funtypes.Literal('uint256') }),
)

const Permit2TokenPermissions = funtypes.ReadonlyObject({
	token: EthereumAddress,
	amount: NonHexBigInt,
})

const Permit2SinglePermittedType = funtypes.ReadonlyObject({ name: funtypes.Literal('permitted'), type: funtypes.Literal('TokenPermissions') })
const Permit2BatchPermittedType = funtypes.ReadonlyObject({ name: funtypes.Literal('permitted'), type: funtypes.Literal('TokenPermissions[]') })
const Permit2SignatureTransferSpenderType = funtypes.ReadonlyObject({ name: funtypes.Literal('spender'), type: funtypes.Literal('address') })
const Permit2SignatureTransferNonceType = funtypes.ReadonlyObject({ name: funtypes.Literal('nonce'), type: funtypes.Literal('uint256') })
const Permit2SignatureTransferDeadlineType = funtypes.ReadonlyObject({ name: funtypes.Literal('deadline'), type: funtypes.Literal('uint256') })
// Integrators choose both the witness field name and its type, for example UniswapX signs `ExclusiveDutchOrder witness`.
const Permit2WitnessType = funtypes.ReadonlyObject({ name: funtypes.String, type: funtypes.String })

const Permit2SingleTransferMessage = funtypes.ReadonlyObject({
	permitted: Permit2TokenPermissions,
	spender: EthereumAddress,
	nonce: NonHexBigInt,
	deadline: NonHexBigInt,
})

const Permit2BatchTransferMessage = funtypes.ReadonlyObject({
	permitted: funtypes.ReadonlyArray(Permit2TokenPermissions),
	spender: EthereumAddress,
	nonce: NonHexBigInt,
	deadline: NonHexBigInt,
})

// Permit2 SignatureTransfer `PermitTransferFrom`, which lets the spender transfer one token once before the deadline.
const Permit2TransferFrom = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitTransferFrom: funtypes.ReadonlyTuple(Permit2SinglePermittedType, Permit2SignatureTransferSpenderType, Permit2SignatureTransferNonceType, Permit2SignatureTransferDeadlineType),
		TokenPermissions: Permit2TokenPermissionsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitTransferFrom'),
	message: Permit2SingleTransferMessage,
})

// Permit2 SignatureTransfer `PermitBatchTransferFrom`, the multi token version of `PermitTransferFrom`.
const Permit2BatchTransferFrom = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitBatchTransferFrom: funtypes.ReadonlyTuple(Permit2BatchPermittedType, Permit2SignatureTransferSpenderType, Permit2SignatureTransferNonceType, Permit2SignatureTransferDeadlineType),
		TokenPermissions: Permit2TokenPermissionsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitBatchTransferFrom'),
	message: Permit2BatchTransferMessage,
})

// Permit2 SignatureTransfer `PermitWitnessTransferFrom`, a `PermitTransferFrom` that also signs integrator defined witness data. Funtypes drops unknown keys, so the witness value is read from the original request after the EIP-712 verifier has checked it against its declared type.
const Permit2WitnessTransferFrom = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitWitnessTransferFrom: funtypes.ReadonlyTuple(Permit2SinglePermittedType, Permit2SignatureTransferSpenderType, Permit2SignatureTransferNonceType, Permit2SignatureTransferDeadlineType, Permit2WitnessType),
		TokenPermissions: Permit2TokenPermissionsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitWitnessTransferFrom'),
	message: Permit2SingleTransferMessage,
})

// Permit2 SignatureTransfer `PermitBatchWitnessTransferFrom`, the multi token version of `PermitWitnessTransferFrom`.
const Permit2BatchWitnessTransferFrom = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		PermitBatchWitnessTransferFrom: funtypes.ReadonlyTuple(Permit2BatchPermittedType, Permit2SignatureTransferSpenderType, Permit2SignatureTransferNonceType, Permit2SignatureTransferDeadlineType, Permit2WitnessType),
		TokenPermissions: Permit2TokenPermissionsTypes,
		EIP712Domain: Permit2EIP712DomainTypes,
	}),
	domain: Permit2Domain,
	primaryType: funtypes.Literal('PermitBatchWitnessTransferFrom'),
	message: Permit2BatchTransferMessage,
})

export type Permit2SignatureTransfer = funtypes.Static<typeof Permit2SignatureTransfer>
export const Permit2SignatureTransfer = funtypes.Union(Permit2TransferFrom, Permit2BatchTransferFrom, Permit2WitnessTransferFrom, Permit2BatchWitnessTransferFrom)

type Permit2StructField = { readonly name: string, readonly type: string }

export type Permit2SignatureTransferKind = {
	readonly isBatch: boolean
	readonly hasWitness: boolean
	// Single token transfers are listed as a one element array so single and batch transfers are handled the same way.
	readonly permitted: readonly funtypes.Static<typeof Permit2TokenPermissions>[]
	readonly structFields: readonly Permit2StructField[]
}

// The only place that tells the SignatureTransfer primary types apart, so token grouping, witness lookup and naming always agree on the kind.
export function getPermit2SignatureTransferKind(permit: Permit2SignatureTransfer): Permit2SignatureTransferKind {
	switch (permit.primaryType) {
		case 'PermitTransferFrom': return { isBatch: false, hasWitness: false, permitted: [permit.message.permitted], structFields: permit.types.PermitTransferFrom }
		case 'PermitBatchTransferFrom': return { isBatch: true, hasWitness: false, permitted: permit.message.permitted, structFields: permit.types.PermitBatchTransferFrom }
		case 'PermitWitnessTransferFrom': return { isBatch: false, hasWitness: true, permitted: [permit.message.permitted], structFields: permit.types.PermitWitnessTransferFrom }
		case 'PermitBatchWitnessTransferFrom': return { isBatch: true, hasWitness: true, permitted: permit.message.permitted, structFields: permit.types.PermitBatchWitnessTransferFrom }
		default: return assertNever(permit)
	}
}

// Permit2 itself defines these SignatureTransfer fields, while the integrator names the witness field, for example `witness` in UniswapX.
const permit2SignatureTransferFieldNames: readonly string[] = ['permitted', 'spender', 'nonce', 'deadline']

// Finds the witness by name instead of by position, and returns undefined unless exactly one field is not a Permit2 field, so a Permit2 field is never taken as the witness.
export function findPermit2WitnessField(structFields: readonly Permit2StructField[]) {
	const witnessFields = structFields.filter(({ name }) => !permit2SignatureTransferFieldNames.includes(name))
	return witnessFields.length === 1 ? witnessFields[0] : undefined
}

type SeaPortItemType = funtypes.Static<typeof SeaPortItemType>
const SeaPortItemType = funtypes.Union(
	funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'NATIVE' as const)),
	funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'ERC20' as const)),
	funtypes.Literal('2').withParser(LiteralConverterParserFactory('2', 'ERC721' as const)),
	funtypes.Literal('3').withParser(LiteralConverterParserFactory('3', 'ERC1155' as const)),
	funtypes.Literal('4').withParser(LiteralConverterParserFactory('4', 'ERC721_WITH_CRITERIA' as const)),
	funtypes.Literal('5').withParser(LiteralConverterParserFactory('5', 'ERC1155_WITH_CRITERIA' as const)),
)

type SeaPortOrderType = funtypes.Static<typeof SeaPortOrderType>
const SeaPortOrderType = funtypes.Union(
	funtypes.Literal('0').withParser(LiteralConverterParserFactory('0', 'FULL_OPEN' as const)),
	funtypes.Literal('1').withParser(LiteralConverterParserFactory('1', 'PARTIAL_OPEN' as const)),
	funtypes.Literal('2').withParser(LiteralConverterParserFactory('2', 'FULL_RESTRICTED' as const)),
	funtypes.Literal('3').withParser(LiteralConverterParserFactory('3', 'PARTIAL_RESTRICTED' as const)),
	funtypes.Literal('4').withParser(LiteralConverterParserFactory('4', 'CONTRACT' as const)),
)

type SeaPortSingleOffer = funtypes.Static<typeof SeaPortSingleOffer>
const SeaPortSingleOffer = funtypes.ReadonlyObject({
	itemType: SeaPortItemType,
	token: EthereumAddress,
	identifierOrCriteria: NonHexBigInt,
	startAmount: NonHexBigInt,
	endAmount: NonHexBigInt
})

type SeaPortSingleConsideration = funtypes.Static<typeof SeaPortSingleConsideration>
const SeaPortSingleConsideration = funtypes.ReadonlyObject({
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

type OpenSeaOrder = funtypes.Static<typeof OpenSeaOrder>
const OpenSeaOrder = funtypes.ReadonlyObject({
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

export type SeaPortSingleOfferWithAddressBookEntries = funtypes.Static<typeof SeaPortSingleOfferWithAddressBookEntries >
export const SeaPortSingleOfferWithAddressBookEntries = funtypes.ReadonlyObject({
	itemType: SeaPortItemType,
	token: AddressBookEntry,
	identifierOrCriteria: NonHexBigInt,
	startAmount: NonHexBigInt,
	endAmount: NonHexBigInt
})

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

type PersonalSignRequestBase = funtypes.Static<typeof PersonalSignRequestBase>
const PersonalSignRequestBase = funtypes.Intersect(
	funtypes.ReadonlyObject({
		activeAddress: AddressBookEntry,
		rpcNetwork: RpcNetwork,
		simulationMode: funtypes.Boolean,
		signerName: SignerName,
		quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
		quarantine: funtypes.Boolean,
		account: AddressBookEntry,
		website: Website,
		created: EthereumTimestamp,
		rawMessage: funtypes.String,
		stringifiedMessage: funtypes.String,
		messageIdentifier: EthereumQuantity,
	}),
	funtypes.ReadonlyPartial({
		isValidMessage: funtypes.Boolean,
	})
)

type VisualizedPersonalSignRequestNotParsed = funtypes.Static<typeof VisualizedPersonalSignRequest>
const VisualizedPersonalSignRequestNotParsed = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: funtypes.Union(funtypes.Literal('personal_sign'), funtypes.Literal('eth_signTypedData'), funtypes.Literal('eth_signTypedData_v1'), funtypes.Literal('eth_signTypedData_v2'), funtypes.Literal('eth_signTypedData_v3'), funtypes.Literal('eth_signTypedData_v4')),
		type: funtypes.Literal('NotParsed'),
		message: funtypes.String,
		messageHash: funtypes.Union(funtypes.String, funtypes.Undefined),
	})
)

type EthSignTyped = funtypes.Static<typeof EthSignTyped>
const EthSignTyped = funtypes.Union(
	funtypes.Literal('eth_signTypedData_v1'),
	funtypes.Literal('eth_signTypedData_v2'),
	funtypes.Literal('eth_signTypedData_v3'),
	funtypes.Literal('eth_signTypedData_v4'),
)

type VisualizedPersonalSignRequestEIP712 = funtypes.Static<typeof VisualizedPersonalSignRequestEIP712>
const VisualizedPersonalSignRequestEIP712 = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('EIP712'),
		message: EnrichedEIP712,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

const VisualizedPersonalSignRequestSafeMessage = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('SafeMessage'),
		message: EnrichedEIP712,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
		review: SafeMessageReview,
	}),
)

export type VisualizedPersonalSignRequestPermit = funtypes.Static<typeof VisualizedPersonalSignRequestPermit>
export const VisualizedPersonalSignRequestPermit = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('Permit'),
		message: EIP2612Message,
		owner: AddressBookEntry,
		spender: AddressBookEntry,
		verifyingContract: AddressBookEntry,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

export type VisualizedPersonalSignRequestPermit2 = funtypes.Static<typeof VisualizedPersonalSignRequestPermit2>
export const VisualizedPersonalSignRequestPermit2 = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('Permit2'),
		message: Permit2,
		token: AddressBookEntry,
		spender: AddressBookEntry,
		verifyingContract: AddressBookEntry,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

const Permit2DetailsWithAddressBookEntry = funtypes.ReadonlyObject({
	token: AddressBookEntry,
	amount: NonHexBigInt,
	expiration: NonHexBigInt,
	nonce: NonHexBigInt,
})

export type VisualizedPersonalSignRequestPermit2Batch = funtypes.Static<typeof VisualizedPersonalSignRequestPermit2Batch>
export const VisualizedPersonalSignRequestPermit2Batch = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('Permit2Batch'),
		message: Permit2Batch,
		details: funtypes.ReadonlyArray(Permit2DetailsWithAddressBookEntry),
		spender: AddressBookEntry,
		verifyingContract: AddressBookEntry,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

const Permit2TokenPermissionsWithAddressBookEntry = funtypes.ReadonlyObject({
	token: AddressBookEntry,
	amount: NonHexBigInt,
})

export type Permit2Witness = funtypes.Static<typeof Permit2Witness>
export const Permit2Witness = funtypes.ReadonlyObject({
	fieldName: funtypes.String,
	typeName: funtypes.String,
	value: EnrichedEIP712MessageRecord,
})

export type VisualizedPersonalSignRequestPermit2SignatureTransfer = funtypes.Static<typeof VisualizedPersonalSignRequestPermit2SignatureTransfer>
export const VisualizedPersonalSignRequestPermit2SignatureTransfer = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('Permit2SignatureTransfer'),
		message: Permit2SignatureTransfer,
		// Single token transfers are listed as a one element array so single and batch transfers render the same way.
		permitted: funtypes.ReadonlyArray(Permit2TokenPermissionsWithAddressBookEntry),
		spender: AddressBookEntry,
		verifyingContract: AddressBookEntry,
		witness: funtypes.Union(Permit2Witness, funtypes.Undefined),
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

type VisualizedPersonalSignRequestOrderComponents = funtypes.Static<typeof VisualizedPersonalSignRequestOrderComponents>
const VisualizedPersonalSignRequestOrderComponents = funtypes.Intersect(
	PersonalSignRequestBase,
	funtypes.ReadonlyObject({
		method: EthSignTyped,
		type: funtypes.Literal('OrderComponents'),
		message: OpenSeaOrderMessageWithAddressBookEntries,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
	})
)

export type SafeTx = funtypes.Static<typeof SafeTx>
export const SafeTx = funtypes.ReadonlyObject({
	types: funtypes.ReadonlyObject({
		SafeTx: funtypes.ReadonlyTuple(
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
		EIP712Domain: funtypes.ReadonlyTuple(
			funtypes.Partial({ name: funtypes.Literal('chainId'), type: funtypes.Literal('uint256') }),
			funtypes.ReadonlyObject({ name: funtypes.Literal('verifyingContract'), type: funtypes.Literal('address') })
		),
	}),
	primaryType: funtypes.Literal('SafeTx'),
	domain: funtypes.Intersect(
		funtypes.Partial({
			chainId: funtypes.Union(EthereumQuantity, NonHexBigInt)
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
		method: EthSignTyped,
		type: funtypes.Literal('SafeTx'),
		message: SafeTx,
		parsedMessageDataAddressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
		parsedMessageData: EnrichedEthereumInputData,
		gasToken: AddressBookEntry,
		to: AddressBookEntry,
		refundReceiver: AddressBookEntry,
		verifyingContract: AddressBookEntry,
		messageHash: funtypes.String,
		domainHash: funtypes.String,
		safeTxHash: funtypes.String,
	})
)

export type VisualizedPersonalSignRequest = funtypes.Static<typeof VisualizedPersonalSignRequest>
export const VisualizedPersonalSignRequest = funtypes.Union(
	VisualizedPersonalSignRequestNotParsed,
	VisualizedPersonalSignRequestEIP712,
	VisualizedPersonalSignRequestSafeMessage,
	VisualizedPersonalSignRequestPermit,
	VisualizedPersonalSignRequestPermit2,
	VisualizedPersonalSignRequestPermit2Batch,
	VisualizedPersonalSignRequestPermit2SignatureTransfer,
	VisualizedPersonalSignRequestSafeTx,
	VisualizedPersonalSignRequestOrderComponents,
)

export type PersonalSignRequestIdentifiedEIP712Message = funtypes.Static<typeof PersonalSignRequestIdentifiedEIP712Message>
export const PersonalSignRequestIdentifiedEIP712Message = funtypes.Union(EIP2612Message, Permit2, Permit2Batch, Permit2SignatureTransfer, OpenSeaOrder, SafeTx)
