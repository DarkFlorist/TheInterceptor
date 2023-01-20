import { ethers } from 'ethers'
import { getTokenAmountsWorth } from '../../simulation/priceEstimator.js'
import { abs, addressString, bigintToDecimalString, bigintToRoundedPrettyDecimalString } from '../../utils/bigint.js'
import { CHAINS } from '../../utils/constants.js'
import { CHAIN } from '../../utils/user-interface-types.js'
import { AddressMetadata, TokenPriceEstimate, TokenVisualizerResult } from '../../utils/visualizer-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import Blockie from './PreactBlocky.js'

type TokenData = {
	decimals: bigint | undefined
	name: string
	symbol: string
	logoUri?: string
}

export function getTokenData(token: bigint, metadata: AddressMetadata | undefined) : TokenData {
	if (metadata === undefined) {
		return {
			decimals: undefined,
			name: `Token (${ ethers.utils.getAddress(addressString(token)) })`,
			symbol: '???',
			logoUri: undefined
		}
	}
	return {
		decimals: 'decimals' in metadata ? metadata.decimals : undefined,
		name: metadata.name,
		symbol: 'symbol' in metadata ? metadata.symbol : '???',
		logoUri: 'logoUri' in metadata && metadata.logoUri !== undefined ? metadata.logoUri : undefined
	}
}

type EtherParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
}

export function Ether(param: EtherParams) {
	return <table class = 'log-table' style = 'width: fit-content'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<EtherAmount
				amount = { param.amount }
				textColor = { param.textColor }
				showSign = { param.showSign }
			/>
		</div>
		<div class = 'log-cell'>
			<EtherSymbol
				amount = { param.amount }
				textColor = { param.textColor }
				useFullTokenName = { param.useFullTokenName }
				chain = { param.chain }
			/>
		</div>
	</table>
}
type EtherAmountParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
}

export function EtherAmount(param: EtherAmountParams) {
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''

	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = 'Ether amount copied!' >
			<p class = 'noselect nopointer' style = { `overflow: hidden; text-overflow: ellipsis; display: inline-block; color: ${ color };` }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), 18n ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type EtherSymbolParams = {
	amount: bigint
	textColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
}

export function EtherSymbol(param: EtherSymbolParams) {
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	return <div style = 'overflow: initial; height: 28px;'>
		<img class = 'noselect nopointer vertical-center' style = 'height: 25px; width: 16px; display: inline-block' src = '../../img/coins/ethereum.png'/>
		<p class = 'noselect nopointer'  style = { `color: ${ color }; display: inline-block` }> { param.useFullTokenName ? CHAINS[param.chain].currencyName : CHAINS[param.chain].currencyTicker } </p>
	</div>
}

type TokenPriceParams = {
	textColor?: string,
	amount: bigint,
	chain: CHAIN,
	tokenPriceEstimate: TokenPriceEstimate | undefined
}

export function TokenPrice(param: TokenPriceParams) {
	if ( param.tokenPriceEstimate === undefined ) return <></>
	const value = getTokenAmountsWorth(param.amount, param.tokenPriceEstimate)
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	return <>
		<p style = { `color: ${ color }` }>&nbsp;(</p>
		<Ether
			amount = { value }
			chain = { param.chain }
			textColor = { color }
		/>
		<p style = { `color: ${ color }` }>)</p>
	</>
}

type TokenSymbolParams = {
	token: bigint,
	textColor?: string,
	addressMetadata: AddressMetadata | undefined,
	useFullTokenName: boolean | undefined
}

export function TokenSymbol(param: TokenSymbolParams) {
	const tokenData = getTokenData(param.token, param.addressMetadata)
	const tokenString = ethers.utils.getAddress(addressString(param.token))
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	return <>
		<div style = 'overflow: initial; height: 28px;'>
			<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
				{ tokenData.logoUri === undefined ?
					<Blockie
						seed = { tokenString.toLowerCase() }
						size = { 8 }
						scale = { 3 }
						borderRadius = { '50%' }
					/>
				:
				<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; max-width: 25px;' src = { tokenData.logoUri }/>
				}
			</CopyToClipboard>
		</div>
		<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
			{ param.useFullTokenName ?
				<p class = 'noselect nopointer' style = { `color: ${ color }; display: inline-block; overflow: hidden; text-overflow: ellipsis;` }>
					{ `${ tokenData.name }` }
				</p>
			:
				<p class = 'noselect nopointer' style = { `color: ${ color }; display: inline-block; overflow: hidden; text-overflow: ellipsis;` }>
					{ `${ tokenData.symbol }` }
				</p>
			}
		</CopyToClipboard>
	</>
}

type TokenAmountParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	addressMetadata: AddressMetadata | undefined
}

export function TokenAmount(param: TokenAmountParams) {
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	const decimals = param.addressMetadata && 'decimals' in param.addressMetadata ? param.addressMetadata.decimals : undefined
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''

	if (decimals === undefined) {
		return <p class = 'noselect nopointer ellipsis' style = { `display: inline-block; color: ${ color };` }> &nbsp;Unknown Amount&nbsp; </p>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), decimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { `display: inline-block; color: ${ color };` }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), decimals ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type TokenParams = {
	amount: bigint
	token: bigint
	showSign?: boolean
	textColor?: string
	addressMetadata: AddressMetadata | undefined
	useFullTokenName: boolean
}

export function Token(param: TokenParams) {
	return <table class = 'log-table' style = 'width: fit-content'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<TokenAmount
				amount = { param.amount }
				showSign = { param.showSign }
				textColor = { param.textColor }
				addressMetadata = { param.addressMetadata }
			/>
		</div>
		<div class = 'log-cell'>
			<TokenSymbol
				token = { param.token }
				addressMetadata = { param.addressMetadata }
				textColor = { param.textColor }
				useFullTokenName = { param.useFullTokenName }
			/>
		</div>
	</table>
}

function truncate(str: string, n: number){
	return (str.length > n) ? `${str.slice(0, n-1)}…` : str;
}

type ERC721TokenNumberParams = {
	tokenId: bigint
	received: boolean
	textColor?: string
	showSign?: boolean
}

export function ERC721TokenNumber(param: ERC721TokenNumberParams) {
	const sign = param.showSign ? (param.received ? ' + ' : ' - ') : ''

	return <CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token ID copied!' >
		<p class = 'noselect nopointer' style = {`display: inline; color: ${ param.textColor ? param.textColor : 'var(--text-color)' } `}>
			{ `${ sign } NFT #${ truncate(param.tokenId.toString(), 9) }`}&nbsp;
		</p>
	</CopyToClipboard>
}

type ERC72TokenParams = {
	tokenId: bigint
	token: bigint
	received: boolean
	textColor?: string
	addressMetadata: AddressMetadata | undefined
	useFullTokenName: boolean
	showSign?: boolean
}

export function ERC721Token(param: ERC72TokenParams) {
	return <table class = 'log-table'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<ERC721TokenNumber
				tokenId = { param.tokenId }
				received = { param.received }
				textColor = { param.textColor }
				showSign = { param.showSign }
			/>
		</div>
		<div class = 'log-cell'>
			<TokenSymbol
				token = { param.token }
				addressMetadata = { param.addressMetadata }
				textColor = { param.textColor }
				useFullTokenName = { param.useFullTokenName }
			/>
		</div>
	</table>
}

type TokenTextParams = {
	useFullTokenName: boolean,
	isApproval: boolean,
	amount: bigint,
	tokenAddress: bigint,
	addressMetadata: AddressMetadata | undefined,
	textColor: string,
	negativeColor: string
}

export function TokenText(param: TokenTextParams) {
	if (param.isApproval && param.amount > 2n ** 100n) {
		return <>
			<p style = { `display: inline-block; color: ${ param.negativeColor };` } > <b>ALL</b> </p>
			<TokenSymbol token = { param.tokenAddress } addressMetadata = { param.addressMetadata } textColor = { param.negativeColor }  useFullTokenName = { param.useFullTokenName }/>
		</>
	}
	if (param.isApproval) {
		return <p style = { `display: inline-block; color: ${ param.negativeColor };` } >
			<Token amount = { param.amount } token = { param.tokenAddress } addressMetadata = { param.addressMetadata } textColor = { param.negativeColor } useFullTokenName = { param.useFullTokenName }/>
		</p>
	}
	return <Token
		amount = { param.amount }
		token = { param.tokenAddress }
		addressMetadata = { param.addressMetadata }
		textColor = { param.textColor }
		useFullTokenName = { param.useFullTokenName }
	/>
}

type Token721AmountFieldParams = {
	visResult: TokenVisualizerResult,
	textColor: string,
}

export function Token721AmountField(param: Token721AmountFieldParams ) {
	if (param.visResult.is721 !== true) throw `needs to be erc721`
	const color = param.textColor ? param.textColor : 'var(--text-color)'
	if (!param.visResult.isApproval || !('isAllApproval' in param.visResult)) {
		return <p style = { `color: ${ color }` }>{ `NFT #${ truncate(param.visResult.tokenId.toString(), 9) }` }</p>
	}
	if (!param.visResult.allApprovalAdded) return <p style = { `color: ${ color }` }><b>NONE</b></p>
	return <p style = { `color: ${ color }` }><b>ALL</b></p>
}
