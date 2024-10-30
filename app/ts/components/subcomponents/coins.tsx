import { useSignal } from '@preact/signals'
import { getTokenAmountsWorth } from '../../simulation/services/priceEstimator.js'
import { abs, bigintToDecimalString, checksummedAddress } from '../../utils/bigint.js'
import { TokenPriceEstimate } from '../../types/visualizer-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { JSX } from 'preact/jsx-runtime'
import { useEffect } from 'preact/hooks'
import { Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { ETHEREUM_COIN_ICON, ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { RpcNetwork } from '../../types/rpc.js'
import { Blockie } from './SVGBlockie.js'
import { AbbreviatedValue } from './AbbreviatedValue.js'
import { InlineCard } from './InlineCard.js'

type EtherParams = {
	amount: bigint
	showSign?: boolean
	useFullTokenName?: boolean
	rpcNetwork: RpcNetwork
	style?: JSX.CSSProperties
	fontSize: 'normal' | 'big'
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
	fontSize: 'normal' | 'big'
}

export function EtherAmount(param: EtherAmountParams) {
	const style:JSX.CSSProperties = {
		display: 'inline-flex',
		overflow: 'hidden',
		alignItems: 'baseline',
		textOverflow: 'ellipsis',
		color: 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
		fontSize: param.fontSize === 'big' ? 'var(--big-font-size)' : 'var(--normal-font-size)'
	}

	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), 18n) } copyMessage = 'Ether amount copied!' >
			<p class = 'noselect nopointer' style = { style }>
				<AbbreviatedValue amount = { param.amount } />
			</p>
		</CopyToClipboard>
	</>
}

type EtherSymbolParams = {
	useFullTokenName?: boolean
	rpcNetwork: RpcNetwork
	style?: JSX.CSSProperties
	fontSize: 'normal' | 'big'
}

export function EtherSymbol(param: EtherSymbolParams) {
	const etherName = param.useFullTokenName ? param.rpcNetwork.currencyName : param.rpcNetwork.currencyTicker
	const Icon = () => <img class = 'noselect nopointer' src = { ETHEREUM_COIN_ICON }/>
	return <InlineCard label = { etherName } noCopy icon = { Icon } style = { { '--bg-color': '#0000001a', '--min-text-width': '4ch', marginLeft: '0.25em' } } />
}

type TokenPriceParams = {
	amount: bigint,
	quoteTokenEntry: Erc20TokenEntry
	tokenPriceEstimate: TokenPriceEstimate
	style?: JSX.CSSProperties
	renameAddressCallBack: RenameAddressCallBack
}

export function TokenPrice(param: TokenPriceParams) {
	const value = getTokenAmountsWorth(param.amount, param.tokenPriceEstimate)
	const style = (param.style === undefined ? {} : param.style)
	return <TokenWithAmount
		amount = { value }
		tokenEntry = { param.quoteTokenEntry }
		style = { style }
		fontSize = 'normal'
		renameAddressCallBack = { param.renameAddressCallBack }
		showSign = { true }
	/>
}

type TokenSymbolParams = (
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
	fontSize: 'normal' | 'big'
}

function TokenIdOrNameOrNothing(param: TokenSymbolParams) {
	if (!('tokenId' in param) || param.tokenId === undefined) return <></>
	if ('tokenIdName' in param && param.tokenIdName !== undefined) return <>
		<CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token name copied!' >
			<p class = 'noselect nopointer' style = { param.style }>
				{ param.tokenIdName }&nbsp;
			</p>
		</CopyToClipboard>
	</>
	return <CopyToClipboard content = { param.tokenId.toString() } copyMessage = 'Token identifier copied!' >
		<p class = 'noselect nopointer' style = { param.style }>
			{ `#${ truncate(param.tokenId.toString(), 9) }` }&nbsp;
		</p>
	</CopyToClipboard>
}

export function TokenSymbol(param: TokenSymbolParams) {
	const address = useSignal<bigint>(param.tokenEntry.address)
	useEffect(() => { address.value = param.tokenEntry.address }, [param.tokenEntry.address])

	// TODO: implement untrusted warning in inline card
	// const unTrusted = param.tokenEntry.entrySource === 'OnChain'

	const tokenName = param.useFullTokenName ? param.tokenEntry.name : param.tokenEntry.symbol
	const tokenAddressString = checksummedAddress(param.tokenEntry.address)
	const defaultCardStyles:JSX.CSSProperties = {
		'--bg-color': '#0000001a',				// 10% opaque black
	}

	const generateIcon = () => {
		if (param.tokenEntry.address === ETHEREUM_LOGS_LOGGER_ADDRESS) return <img style = { { minWidth: '1em', minHeight: '1em' } } src = { param.tokenEntry.logoUri } />
		if (param.tokenEntry.logoUri === undefined) return <Blockie address = { param.tokenEntry.address } />
		return <img style = { { minWidth: '1em', minHeight: '1em' } } src = { param.tokenEntry.logoUri } />
	}

	return <>
        <TokenIdOrNameOrNothing { ...param } />
		<InlineCard icon = { generateIcon } copyValue = { tokenAddressString } label = { tokenName } onEditClicked = { () => param.renameAddressCallBack(param.tokenEntry) } style = {{ ...defaultCardStyles, ...param.style }} />
	</>
}

type TokenAmountParams = Omit<TokenSymbolParams, 'renameAddressCallBack'> & {
	amount: bigint
	showSign?: boolean
}

export function TokenAmount(param: TokenAmountParams) {
	const sign = param.showSign ? (param.amount >= 0 ? ' + ' : ' - '): ''
	const style:JSX.CSSProperties = {
		color: 'var(--text-color)',
		display: 'inline-flex',
		alignItems: 'baseline',
		...(param.style === undefined ? {} : param.style),
		fontSize: param.fontSize === 'big' ? 'var(--big-font-size)' : 'var(--normal-font-size)'
	}

	if (!('decimals' in param.tokenEntry) || param.tokenEntry.decimals === undefined) {
		return <>
			<CopyToClipboard content = { `${ abs(param.amount) } (decimals unknown)` } copyMessage = 'Token amount copied!' >
				<p class = 'noselect nopointer' style = { style }>{ `${ sign }${ abs(param.amount).toString() }` }&nbsp; </p>
			</CopyToClipboard>
		</>
	}
	return <>
		<CopyToClipboard content = { bigintToDecimalString(abs(param.amount), param.tokenEntry.decimals) } copyMessage = 'Token amount copied!' >
			<p class = 'noselect nopointer' style = { style }>
				<AbbreviatedValue amount = { param.amount } decimals = { param.tokenEntry.decimals } />
			</p>
		</CopyToClipboard>
	</>
}

type TokenWithAmountParams = TokenSymbolParams & {
	showSign: boolean
	amount: bigint
}

export function TokenWithAmount(param: TokenWithAmountParams) {
	const containerStyles: JSX.CSSProperties = {
		display: 'inline-flex',
		width: 'fit-content',
		columnGap: '0.25ch',
		alignItems: 'baseline'
	}

	return (
		<div style = { containerStyles }>
			<TokenAmount { ...param } />
			<TokenSymbol { ...param }/>
		</div>
	)
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
	return (str.length > n) ? `${ str.slice(0, n-1) }…` : str
}

type AllApprovalParams = {
	style?: JSX.CSSProperties
	type: 'NFT All approval'
	allApprovalAdded: boolean
	fontSize: 'normal' | 'big'
}

export function AllApproval(param: AllApprovalParams ) {
	const style = {
		color: 'var(--text-color)',
		...(param.style === undefined ? {} : param.style),
		'font-size': param.fontSize === 'big' ? 'var(--big-font-size)' : 'var(--normal-font-size)'
	}
	if (!param.allApprovalAdded) return <p style = { style }><b>NONE</b></p>
	return <p style = { style }><b>ALL</b></p>
}
