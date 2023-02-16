import { ethers } from 'ethers'
import { getTokenAmountsWorth } from '../../simulation/priceEstimator.js'
import { abs, addressString, bigintToDecimalString, bigintToRoundedPrettyDecimalString } from '../../utils/bigint.js'
import { CHAINS } from '../../utils/constants.js'
import { CHAIN } from '../../utils/user-interface-types.js'
import { ERC721TokenDefinitionParams, TokenDefinitionParams, TokenPriceEstimate } from '../../utils/visualizer-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import Blockie from './PreactBlocky.js'
import { JSX } from 'preact/jsx-runtime'

type EtherParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
	style?: JSX.CSSProperties
}

export function Ether(param: EtherParams) {
	return <table class = 'log-table' style = 'width: fit-content'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<EtherAmount { ...param } />
		</div>
		<div class = 'log-cell'>
			<EtherSymbol { ...param } />
		</div>
	</table>
}
type EtherAmountParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	style?: JSX.CSSProperties
}

export function EtherAmount(param: EtherAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style = {
		...(param.style === undefined ? {} : param.style),
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		color: param.textColor ? param.textColor : 'var(--text-color)'
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = 'Ether amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), 18n ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type EtherSymbolParams = {
	amount: bigint
	textColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
	style?: JSX.CSSProperties
}

export function EtherSymbol(param: EtherSymbolParams) {
	const style = {
		...(param.style === undefined ? {} : param.style),
		color: param.textColor ? param.textColor : 'var(--text-color)',
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		'margin-left': '2px',
	}
	return <>
		<div style = 'overflow: initial; height: 28px;'>
			<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; max-width: 25px;' src = '../../img/coins/ethereum.png'/>
		</div>
		<p class = 'noselect nopointer' style = { style }> { param.useFullTokenName ? CHAINS[param.chain].currencyName : CHAINS[param.chain].currencyTicker } </p>
	</>
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
	textColor?: string,
	tokenName: string
	tokenAddress: bigint
	tokenSymbol: string
	tokenLogoUri: string | undefined

	useFullTokenName: boolean | undefined
	style?: JSX.CSSProperties
}

export function TokenSymbol(param: TokenSymbolParams) {
	const tokenString = ethers.utils.getAddress(addressString(param.tokenAddress))

	const style = {
		...(param.style === undefined ? {} : param.style),
		color: param.textColor ? param.textColor : 'var(--text-color)',
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		'margin-left': '2px',
	}
	return <>
		<div style = 'overflow: initial; height: 28px;'>
			<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
				{ param.tokenLogoUri === undefined ?
					<Blockie
						seed = { tokenString.toLowerCase() }
						size = { 8 }
						scale = { 3 }
						borderRadius = { '50%' }
					/>
				:
				<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; max-width: 25px;' src = { param.tokenLogoUri }/>
				}
			</CopyToClipboard>
		</div>
		<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
			{ param.useFullTokenName ?
				<p class = 'noselect nopointer' style = { style }>
					{ `${ param.tokenName === undefined ? tokenString : param.tokenName }` }
				</p>
			:
				<p class = 'noselect nopointer' style = { style }>
					{ `${ param.tokenSymbol }` }
				</p>
			}
		</CopyToClipboard>
	</>
}

type TokenAmountParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	tokenDecimals: bigint | undefined
	style?: JSX.CSSProperties
}

export function TokenAmount(param: TokenAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style = {
		...(param.style === undefined ? {} : param.style),
		display: 'inline-block',
		color: param.textColor ? param.textColor : 'var(--text-color)'
	}

	if (param.tokenDecimals === undefined) {
		return <p class = 'noselect nopointer ellipsis' style = { style }> &nbsp;Unknown Amount&nbsp; </p>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), param.tokenDecimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), param.tokenDecimals ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type TokenParams = TokenDefinitionParams & {
	amount: bigint
	showSign?: boolean
	textColor?: string
	useFullTokenName: boolean
	style?: JSX.CSSProperties
}

export function Token(param: TokenParams) {
	return <table class = 'log-table' style = 'width: fit-content'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<TokenAmount { ...param } />
		</div>
		<div class = 'log-cell'>
			<TokenSymbol { ... param }/>
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
	style?: JSX.CSSProperties
}

export function ERC721TokenNumber(param: ERC721TokenNumberParams) {
	const sign = param.showSign ? (param.received ? ' + ' : ' - ') : ''
	const style = {
		...(param.style === undefined ? {} : param.style),
		display: 'inline',
		color: param.textColor ? param.textColor : 'var(--text-color)',
	}

	return <CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token ID copied!' >
		<p class = 'noselect nopointer' style = { style }>
			{ `${ sign } NFT #${ truncate(param.tokenId.toString(), 9) }`}&nbsp;
		</p>
	</CopyToClipboard>
}

type ERC721TokenParams = ERC721TokenDefinitionParams & {
	received: boolean
	textColor?: string
	useFullTokenName: boolean
	showSign?: boolean
	style?: JSX.CSSProperties
}

export function ERC721Token(param: ERC721TokenParams) {
	return <table class = 'log-table'>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<ERC721TokenNumber { ... param }/>
		</div>
		<div class = 'log-cell'>
			<TokenSymbol { ...param }/>
		</div>
	</table>
}

type Token721AmountFieldParams = {
	textColor: string
	style?: JSX.CSSProperties
} & ({
	tokenId: bigint
	isApproval: boolean
} | {
	isAllApproval: boolean
	allApprovalAdded: boolean
	isApproval: true
})


export function Token721AmountField(param: Token721AmountFieldParams ) {
	const style = {
		...(param.style === undefined ? {} : param.style),
		color: param.textColor ? param.textColor : 'var(--text-color)'
	}
	if (!param.isApproval || !('isAllApproval' in param)) {
		return <p style = { style }>{ `NFT #${ truncate(param.tokenId.toString(), 9) }` }</p>
	}
	if (!param.allApprovalAdded) return <p style = { style }><b>NONE</b></p>
	return <p style = { style }><b>ALL</b></p>
}
