import { useSignal } from '@preact/signals'
import { getTokenAmountsWorth } from '../../simulation/priceEstimator.js'
import { abs, bigintToDecimalString, bigintToRoundedPrettyDecimalString, checksummedAddress } from '../../utils/bigint.js'
import { TokenPriceEstimate, RpcNetwork } from '../../types/visualizer-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { Blockie } from './PreactBlocky.js'
import { JSX } from 'preact/jsx-runtime'
import { useEffect } from 'preact/hooks'
import { Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { BIG_FONT_SIZE } from '../../utils/constants.js'

type EtherParams = {
	amount: bigint
	showSign?: boolean
	useFullTokenName?: boolean
	rpcNetwork: RpcNetwork
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
	style?: JSX.CSSProperties
}

export function EtherAmount(param: EtherAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style = {
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		color: 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = 'Ether amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), 18n ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type EtherSymbolParams = {
	useFullTokenName?: boolean
	rpcNetwork: RpcNetwork
	style?: JSX.CSSProperties
}

export function EtherSymbol(param: EtherSymbolParams) {
	const style = {
		color: 'var(--text-color)',
		display: 'inline-block',
		overflow: 'hidden',
		'text-overflow': 'ellipsis',
		'margin-left': '2px',
		...(param.style === undefined ? {} : param.style),
	}
	const etheName = param.useFullTokenName ? param.rpcNetwork.currencyName : param.rpcNetwork.currencyTicker

	return <>
		<div style = 'overflow: initial; height: 28px;'>
			<img class = 'noselect nopointer' style = 'max-height: 25px; max-width: 25px;' src = '../../img/coins/ethereum.png'/>
		</div>
		<p class = 'noselect nopointer' style = { style }> { etheName } </p>
	</>
}

type TokenPriceParams = {
	amount: bigint,
	rpcNetwork: RpcNetwork
	tokenPriceEstimate: TokenPriceEstimate | undefined
	style?: JSX.CSSProperties
}

export function TokenPrice(param: TokenPriceParams) {
	if (param.tokenPriceEstimate === undefined) return <></>
	const value = getTokenAmountsWorth(param.amount, param.tokenPriceEstimate)
	const style = (param.style === undefined ? {} : param.style)
	return <>
		<p style = { style }>&nbsp;(</p>
		<Ether
			amount = { value }
			rpcNetwork = { param.rpcNetwork }
			style = { style }
		/>
		<p style = { style }>)</p>
	</>
}

export type TokenSymbolParams = (
	{
		tokenEntry: Erc1155Entry | Erc721Entry
		tokenId: bigint | undefined
		tokenIdName?: string
	} | { 
		tokenEntry: Erc20TokenEntry
	}
) & {
	useFullTokenName?: boolean
	style?: JSX.CSSProperties
	renameAddressCallBack: RenameAddressCallBack
}

function TokenIdOrNameOrNothing(param: TokenSymbolParams) {
	if (!('tokenId' in param) || param.tokenId === undefined) return <></>
	if ('tokenIdName' in param && param.tokenIdName !== undefined) return <>
		<CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token name copied!' >
			<p class = 'noselect nopointer' style = { param.style }>
				{ param.tokenIdName }
			</p>
		</CopyToClipboard>
	</>
	return <CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token identifier copied!' >
		<p class = 'noselect nopointer' style = { param.style }>
			{ `#${ truncate(param.tokenId.toString(), 9) } ` }
		</p>
	</CopyToClipboard>
}

export function TokenSymbol(param: TokenSymbolParams) {
	const address = useSignal<bigint>(param.tokenEntry.address)
	useEffect(() => { address.value = param.tokenEntry.address }, [param.tokenEntry.address])

	const tokenString = checksummedAddress(param.tokenEntry.address)
	const unTrusted = param.tokenEntry.entrySource === 'OnChain'
	const big = 'style' in param && param.style !== undefined && 'font-size' in param.style && param.style['font-size'] === BIG_FONT_SIZE
	const style = {
		color: 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
		...unTrusted ? { color: 'var(--warning-color)' } : {},
	}

	const name = param.useFullTokenName ? param.tokenEntry.name : param.tokenEntry.symbol
	return <span style = 'display: flex'>
		<TokenIdOrNameOrNothing { ...param } style = { style }/>
		<span className = { big ? 'big-token-name-container' : 'token-name-container' } data-value = { unTrusted ? `⚠${ name }` : name }>
			<span class = 'token-name-holder'>
				<span style = 'margin-right: 2px'>
					<CopyToClipboard content = { tokenString } copyMessage = 'Token address copied!' >
						{ param.tokenEntry.logoUri === undefined ?
							<Blockie
								address = { useSignal(param.tokenEntry.address) }
								scale = { useSignal(3) }
								style = { { 'vertical-align': 'baseline', borderRadius: '50%' } }
							/>
						:
							<img class = 'noselect nopointer' style = { { 'max-height': '25px', 'max-width': '25px', 'vertical-align': 'middle;' } } src = { param.tokenEntry.logoUri }/>
						}
					</CopyToClipboard>
				</span>
				{ unTrusted ? <p class = 'noselect nopointer blink' style = { style } >⚠</p> : <></> }
				<CopyToClipboard content = { name } copyMessage = 'Name copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
					<p class = 'paragraph token-name-text noselect nopointer' style = { style }>{ name }</p>
				</CopyToClipboard>
				<button className = 'button is-primary is-small rename-token-button' onClick = { () => param.renameAddressCallBack(param.tokenEntry) }>
					<span class = 'icon'>
						<img src = '../img/rename.svg'/>
					</span>
				</button>
			</span>
		</span>
	</span>
}

type TokenAmountParams = Omit<TokenSymbolParams, 'renameAddressCallBack'> & {
	amount: bigint
	showSign?: boolean
}

export function TokenAmount(param: TokenAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style = {
		color: 'var(--text-color)',
		display: 'inline-block',
		...(param.style === undefined ? {} : param.style),
	}

	if (!('decimals' in param.tokenEntry) || param.tokenEntry.decimals === undefined) {
		return <>
			<CopyToClipboard content = { `${ abs(param.amount) } (decimals unknown)`} copyMessage = 'Token amount copied!' >
				<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ abs(param.amount).toString() }` }&nbsp; </p>
			</CopyToClipboard>
		</>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), param.tokenEntry.decimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ bigintToRoundedPrettyDecimalString(abs(param.amount), param.tokenEntry.decimals ) }` }&nbsp; </p>
		</CopyToClipboard>
	</>
}

type TokenWithAmountParams = TokenSymbolParams & {
	showSign: boolean
	amount: bigint
}

export function TokenWithAmount(param: TokenWithAmountParams) {
	return <div style = 'width: fit-content; display: flex'>
		<TokenAmount { ...param } />
		<TokenSymbol { ...param }/>
	</div>
}

export type TokenOrEtherParams = TokenWithAmountParams | EtherParams | TokenSymbolParams

export function TokenOrEth(param: TokenOrEtherParams) {
	if (!('tokenEntry' in param)) return <Ether { ...param }/>
	if ('amount' in param) {
		return <TokenWithAmount { ...param }/>
	}
	return <TokenSymbol { ...param }/>
}

export function TokenOrEthSymbol(param: TokenSymbolParams | EtherSymbolParams) {
	if ('tokenEntry' in param) {
		return <TokenSymbol { ...param }/>
	}
	return <EtherSymbol { ...param }/>
}

export function TokenOrEthValue(param: TokenAmountParams | EtherAmountParams) {
	if ('tokenEntry' in param) {
		return <TokenAmount { ...param }/>
	}
	return <EtherAmount { ...param }/>
}

function truncate(str: string, n: number){
	return (str.length > n) ? `${str.slice(0, n-1)}…` : str;
}

type AllApprovalParams = {
	style?: JSX.CSSProperties
	type: 'NFT All approval'
	allApprovalAdded: boolean
}

export function AllApproval(param: AllApprovalParams ) {
	const style = {
		color: 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
	}
	if (!param.allApprovalAdded) return <p style = { style }><b>NONE</b></p>
	return <p style = { style }><b>ALL</b></p>
}
