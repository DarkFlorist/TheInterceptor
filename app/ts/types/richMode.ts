import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from './wire-types.js'

export type RichTokenType = funtypes.Static<typeof RichTokenType>
export const RichTokenType = funtypes.Union(funtypes.Literal('ERC20'), funtypes.Literal('ERC1155'))

export type Erc1155StorageOrder = funtypes.Static<typeof Erc1155StorageOrder>
export const Erc1155StorageOrder = funtypes.Union(funtypes.Literal('TokenIdThenOwner'), funtypes.Literal('OwnerThenTokenId'))

const richTokenLayoutFields = {
	chainId: EthereumQuantity,
	tokenAddress: EthereumAddress,
	tokenType: RichTokenType,
	tokenId: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	name: funtypes.String,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
	balanceSlot: EthereumQuantity,
	erc1155StorageOrder: funtypes.Union(Erc1155StorageOrder, funtypes.Undefined),
}
export type RichTokenLayout = funtypes.Static<typeof RichTokenLayout>
export const RichTokenLayout = funtypes.ReadonlyObject(richTokenLayoutFields)

export type RichToken = funtypes.Static<typeof RichToken>
// Compatibility/presentation shape. Persisted layouts never contain a funding amount.
export const RichToken = funtypes.ReadonlyObject({ ...richTokenLayoutFields, amount: EthereumQuantity })

export type RichTokenOption = funtypes.Static<typeof RichTokenOption>
export const RichTokenOption = funtypes.ReadonlyObject({
	chainId: EthereumQuantity,
	tokenAddress: EthereumAddress,
	tokenType: RichTokenType,
	tokenId: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	name: funtypes.String,
	symbol: funtypes.String,
	decimals: EthereumQuantity,
	amount: EthereumQuantity,
	balanceSlot: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	erc1155StorageOrder: funtypes.Union(Erc1155StorageOrder, funtypes.Undefined),
	enabled: funtypes.Boolean,
}).And(funtypes.ReadonlyPartial({ logoUri: funtypes.String }))

export const RichTokenOptions = funtypes.ReadonlyArray(RichTokenOption)

export type RichTokenBalance = funtypes.Static<typeof RichTokenBalance>
export const RichTokenBalance = funtypes.ReadonlyObject({
	tokenAddress: EthereumAddress,
	tokenId: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	amount: EthereumQuantity,
})

export type RichAccountBalance = funtypes.Static<typeof RichAccountBalance>
export const RichAccountBalance = funtypes.ReadonlyObject({
	chainId: EthereumQuantity,
	address: EthereumAddress,
	nativeAmount: EthereumQuantity,
	tokenBalances: funtypes.ReadonlyArray(RichTokenBalance),
})

export const RichAccountBalances = funtypes.ReadonlyArray(RichAccountBalance)

export type RichListElement = funtypes.Static<typeof RichListElement>
export const RichListElement = funtypes.ReadonlyObject({
	address: EthereumAddress,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('CurrentActiveAddress'), funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded')),
})

export type RichModeState = funtypes.Static<typeof RichModeState>
export const RichModeState = funtypes.ReadonlyObject({
	makeCurrentAddressRich: funtypes.Boolean,
	fixedAddressRichList: funtypes.ReadonlyArray(RichListElement),
	// Defaults initialize new profiles; editing a profile never changes this value.
	defaultNativeAmount: EthereumQuantity,
	tokenLayouts: funtypes.ReadonlyArray(RichTokenLayout),
	accountBalances: RichAccountBalances,
})
