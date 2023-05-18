import { getTokenAmountsWorth } from '../../simulation/priceEstimator.js'
import { abs, bigintToDecimalString, bigintToRoundedPrettyDecimalString, checksummedAddress } from '../../utils/bigint.js'
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
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		color: param.textColor ? param.textColor : 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = 'Ether amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), 18n ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type EtherSymbolParams = {
	textColor?: string
	useFullTokenName?: boolean
	chain: CHAIN
	style?: JSX.CSSProperties
}

export function EtherSymbol(param: EtherSymbolParams) {
	const style = {
		color: param.textColor ? param.textColor : 'var(--text-color)',
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		'margin-left': '2px',
		...(param.style === undefined ? {} : param.style),
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

export type TokenSymbolParams = {
	textColor?: string,
	name: string
	address: bigint
	symbol: string
	logoUri?: string
	useFullTokenName?: boolean
	style?: JSX.CSSProperties
}

export function TokenSymbol(param: TokenSymbolParams) {
	const tokenString = checksummedAddress(param.address)

	const style = {
		color: param.textColor ? param.textColor : 'var(--text-color)',
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		'margin-left': '2px',
		...(param.style === undefined ? {} : param.style),
	}
	return <>
		<div style = 'overflow: initial; height: 28px;'>
			<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
				{ param.logoUri === undefined ?
					<Blockie
						address = { param.address }
						scale = { 3 }
						borderRadius = { '50%' }
						style = { { 'vertical-align': 'middle' } }
					/>
				:
				<img class = 'noselect nopointer vertical-center' style = 'max-height: 25px; max-width: 25px;' src = { param.logoUri }/>
				}
			</CopyToClipboard>
		</div>
		<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
			{ param.useFullTokenName ?
				<p class = 'noselect nopointer' style = { style }>
					{ `${ param.name === undefined ? tokenString : param.name }` }
				</p>
			:
				<p class = 'noselect nopointer' style = { style }>
					{ `${ param.symbol }` }
				</p>
			}
		</CopyToClipboard>
	</>
}

type TokenAmountParams = {
	amount: bigint
	showSign?: boolean
	textColor?: string
	decimals: bigint | undefined
	style?: JSX.CSSProperties
}

export function TokenAmount(param: TokenAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style = {
		color: param.textColor ? param.textColor : 'var(--text-color)',
		display: 'inline-block',
		...(param.style === undefined ? {} : param.style),
	}

	if (param.decimals === undefined) {
		return <p class = 'noselect nopointer ellipsis' style = { style }> &nbsp;Unknown Amount&nbsp; </p>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), param.decimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), param.decimals ) }` }&nbsp; </p>
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

export type TokenOrEtherParams = TokenParams | EtherParams | ERC721TokenParams

export function TokenOrEth(param: TokenOrEtherParams) {
	if ('decimals' in param) {
		return <Token { ...param }/>
	}
	if ('id' in param) {
		return <ERC721Token { ...param }/>
	}
	return <Ether { ...param }/>
}

export function TokenOrEthSymbol(param: TokenDefinitionParams | ERC721TokenDefinitionParams | EtherSymbolParams) {
	if ('decimals' in param || 'id' in param) {
		return <TokenSymbol { ...param }/>
	}
	return <EtherSymbol { ...param }/>
}

export function TokenOrEthValue(param: TokenAmountParams | EtherAmountParams) {
	if ('decimals' in param) {
		return <TokenAmount { ...param }/>
	}
	return <EtherAmount { ...param }/>
}

function truncate(str: string, n: number){
	return (str.length > n) ? `${str.slice(0, n-1)}…` : str;
}

type ERC721TokenNumberParams = {
	id: bigint
	received: boolean
	textColor?: string
	showSign?: boolean
	style?: JSX.CSSProperties
}

export function ERC721TokenNumber(param: ERC721TokenNumberParams) {
	const sign = param.showSign ? (param.received ? ' + ' : ' - ') : ''
	const style = {
		display: 'inline',
		color: param.textColor ? param.textColor : 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
	}

	return <CopyToClipboard content = { param.id.toString() } copyMessage = 'Token ID copied!' >
		<p class = 'noselect nopointer' style = { style }>
			{ `${ sign } NFT #${ truncate(param.id.toString(), 9) }`}&nbsp;
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
	textColor?: string
	style?: JSX.CSSProperties
} & ({
	type: 'NFT'
	tokenId: bigint
} | {
	type: 'NFT All approval'
	allApprovalAdded: boolean
})


export function Token721AmountField(param: Token721AmountFieldParams ) {
	const style = {
		color: param.textColor ? param.textColor : 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
	}
	if (param.type === 'NFT All approval') {
		if (!param.allApprovalAdded) return <p style = { style }><b>NONE</b></p>
		return <p style = { style }><b>ALL</b></p>
	}
	return <p style = { style }>{ `NFT #${ truncate(param.tokenId.toString(), 9) }` }</p>
}
