import { ethers } from 'ethers'
import { getTokenAmountsWorth } from '../../simulation/priceEstimator.js'
import { abs, addressString, bigintToDecimalString, bigintToRoundedPrettyDecimalString } from '../../utils/bigint.js'
import { CHAINS } from '../../utils/constants.js'
import { CHAIN } from '../../utils/user-interface-types.js'
import { AddressMetadata, TokenPriceEstimate, TokenVisualizerResult } from '../../utils/visualizer-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'

export type EtherParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	negativeColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
}

export type TokenParams = {
	amount: bigint
	token: bigint
	showSign?: boolean
	textColor?: string
	negativeColor?: string
	addressMetadata: AddressMetadata | undefined
	useFullTokenName: boolean
}

export type ERC72TokenParams = {
	tokenId: bigint
	token: bigint
	received: boolean
	textColor?: string
	sentTextColor?: string
	addressMetadata: AddressMetadata | undefined
	useFullTokenName: boolean
	showSign?: boolean
}

export type TokenData = {
	decimals: bigint | undefined
	name: string
	symbol: string
	logoURI: string
}

export function getTokenData(token: bigint, metadata: AddressMetadata | undefined) : TokenData {
	if (metadata === undefined) {
		return {
			decimals: undefined,
			name: `Token (${ ethers.utils.getAddress(addressString(token)) })`,
			symbol: '???',
			logoURI: '../../img/question-mark-sign.svg'
		}
	}
	return {
		decimals: 'decimals' in metadata ? metadata.decimals : undefined,
		name: metadata.name,
		symbol: 'symbol' in metadata ? metadata.symbol : '???',
		logoURI: 'logoURI' in metadata && metadata.logoURI !== undefined ? metadata.logoURI : '../../img/question-mark-sign.svg'
	}
}

export function Ether(param: EtherParams) {
	const positiveColor = param.textColor ? param.textColor : 'var(--text-color)'
	const negativeColor = param.negativeColor ? param.negativeColor : positiveColor
	const color = param.amount >= 0 ? positiveColor : negativeColor
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - ') : ''
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = { `${ CHAINS[param.chain].currencyName } amount copied!` } >
			<p class = 'noselect nopointer' style = {`color: ${ color }; margin-right: 4px; margin-left: 4px;`}> {`${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), 18n) }` } </p>
		</CopyToClipboard>
		<img class = 'noselect nopointer vertical-center' style = 'height: 25px; width: 16px; margin-left: 4px; display: inline-block' src = '../../img/coins/ethereum.png'/>
		<p class = 'noselect nopointer'  style = { `color: ${ color }; display: inline-block` }> { param.useFullTokenName ? CHAINS[param.chain].currencyName : CHAINS[param.chain].currencyTicker } </p>
	</>
}

export function TokenPrice(
	param: {
		textColor?: string,
		negativeColor?: string,
		amount: bigint,
		chain: CHAIN,
		tokenPriceEstimate: TokenPriceEstimate | undefined
	}
) {
	if ( param.tokenPriceEstimate === undefined ) return <></>
	const positiveColor = param.textColor ? param.textColor : 'var(--text-color)'
	const negativeColor = param.negativeColor ? param.negativeColor : positiveColor
	const color = param.amount >= 0 ? positiveColor : negativeColor
	const value = getTokenAmountsWorth(param.amount, param.tokenPriceEstimate)
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(value), 18n) } copyMessage = { `${ CHAINS[param.chain].currencyName } amount copied!` } >
			<p class = 'noselect nopointer' style = {`color: ${ color }; margin-right: 4px; margin-left: 4px;`}> {`(${ bigintToRoundedPrettyDecimalString(abs(value), 18n) }` } </p>
		</CopyToClipboard>
		<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; margin-left: 4px;' src = '../../img/coins/ethereum.png'/>
		<p class = 'noselect nopointer' style = { `color: ${ color };` }>
			{ `${CHAINS[param.chain].currencyTicker})` }
		</p>
	</>
}

export function TokenSymbol(param: { token: bigint, textColor?: string, addressMetadata: AddressMetadata | undefined, useFullTokenName: boolean | undefined }) {
	const tokenData = getTokenData(param.token, param.addressMetadata)
	const tokenString = ethers.utils.getAddress(addressString(param.token))
	return <>
		<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
			<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; max-width: 25px; margin-left: 4px;' src = { tokenData.logoURI }/>
		</CopyToClipboard>
		<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
			{ param.useFullTokenName ?
				<p class = 'noselect nopointer' style = { `color: ${ param.textColor ? param.textColor : 'var(--text-color)' }; display: inline-block` }>
					{ `${ tokenData.name }` }&nbsp;
				</p>
			:
				<p class = 'noselect nopointer' style = { `color: ${ param.textColor ? param.textColor : 'var(--text-color)' }; display: inline-block` }>
					{ `${ tokenData.symbol }` }&nbsp;
				</p>
			}
		</CopyToClipboard>
	</>
}

export function Token(param: TokenParams) {
	const positiveColor = param.textColor ? param.textColor : 'var(--text-color)'
	const negativeColor = param.negativeColor ? param.negativeColor : positiveColor
	const decimals = param.addressMetadata && 'decimals' in param.addressMetadata ? param.addressMetadata.decimals : undefined
	const color = param.amount >= 0 ? positiveColor : negativeColor
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''

	if(decimals === undefined) {
		return <>
			<p class = 'noselect nopointer' style = {`display: inline-block; color: ${ color };`}> &nbsp;Unknown Amount&nbsp; </p>
			<TokenSymbol token = { param.token } addressMetadata = { param.addressMetadata } textColor = { color } useFullTokenName = { param.useFullTokenName }/>
		</>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), decimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { `display: inline-block; color: ${ color };`}>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), decimals ) }` }&nbsp; </p>
		</CopyToClipboard>
		<TokenSymbol token = { param.token } addressMetadata = { param.addressMetadata } textColor = { color } useFullTokenName = { param.useFullTokenName }/>
	</>
}

function truncate(str: string, n: number){
	return (str.length > n) ? `${str.slice(0, n-1)}…` : str;
}

export function ERC721Token(param: ERC72TokenParams) {
	const positiveColor = param.textColor ? param.textColor : 'var(--text-color)'
	const negativeColor = param.sentTextColor ? param.sentTextColor : positiveColor
	const color = param.received ? positiveColor : negativeColor
	const sign = param.showSign ? (param.received ? ' + ' : ' - ') : ''
	return <div class = 'vertical-center' style = 'display: inline-block;'>
		<CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token ID copied!' >
			<p class = 'vertical-center noselect nopointer tokentext' style = {`display: inline; color: ${ color }; margin-right: 4px; margin-left: 4px;`}>
				{`${ sign } NFT #${ truncate(param.tokenId.toString(), 9) }`}
			</p>
		</CopyToClipboard>
		<TokenSymbol token = { param.token } addressMetadata = { param.addressMetadata } textColor = { color } useFullTokenName = { param.useFullTokenName }/>
	</div>
}

export function TokenText(param: { useFullTokenName: boolean, isApproval: boolean, amount: bigint, tokenAddress: bigint, addressMetadata: AddressMetadata | undefined, textColor: string, negativeColor: string }) {
	if (param.isApproval && param.amount > 2n ** 100n) {
		return <>
			<p style = { `display: inline-block; color: ${ param.negativeColor };` } > ALL </p>
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
export function TokenText721(param: { useFullTokenName: boolean, visResult: TokenVisualizerResult, addressMetadata: AddressMetadata | undefined, textColor: string, negativeColor: string } ) {
	if (param.visResult.is721 !== true) throw `needs to be erc721`

	return <div>
		<p style = { `color: ${ param.visResult.isApproval ? param.negativeColor : param.textColor };` } > { param.visResult.isApproval ? (
				'isAllApproval' in param.visResult ? ( param.visResult.allApprovalAdded ? `Set as Operator` : `Remove Operator`)
					: `Approve NFT #${ truncate(param.visResult.tokenId.toString(), 9) }`
				) : `for NFT #${ truncate(param.visResult.tokenId.toString(), 9) }`
		}
			<TokenSymbol
				token = { param.visResult.tokenAddress }
				addressMetadata = { param.addressMetadata }
				textColor = { param.visResult.isApproval ? param.negativeColor : param.textColor }
				useFullTokenName = { param.useFullTokenName }
			/>
		</p>
	</div>
}
