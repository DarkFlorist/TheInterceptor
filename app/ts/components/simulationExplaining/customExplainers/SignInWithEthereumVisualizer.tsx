import type { VisualizedPersonalSignRequestSignInWithEthereum } from '../../../types/personal-message-definitions.js'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { getSiweOriginText, parseSiweDateTime } from '../../../utils/siwe.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { humanReadableDateDelta, SomeTimeAgo } from '../../subcomponents/SomeTimeAgo.js'
import { CellElement, ExactValue, getChainNameWithId, humanReadableDate } from '../../ui-utils.js'

// SomeTimeAgo passes the seconds left until the date on every tick, so the label switches from "in" to "ago" when an expiry passes while the dialog is open.
const getRelativeTimeText = (secondsUntil: number) => secondsUntil > 0 ? `in ${ humanReadableDateDelta(secondsUntil) }` : `${ humanReadableDateDelta(-secondsUntil) } ago`

function SiweDateTime({ text }: { text: string }) {
	const date = parseSiweDateTime(text)
	if (date === undefined) return <>{ text }</>
	return <>{ humanReadableDate(date) } (<SomeTimeAgo priorTimestamp = { date } countBackwards = { true } diffToText = { getRelativeTimeText }/>)</>
}

function SiweDateTimeRow({ label, text }: { label: string, text: string | undefined }) {
	if (text === undefined) return <></>
	return <>
		<CellElement text = { label }/>
		<CellElement text = { <SiweDateTime text = { text }/> }/>
	</>
}

type SignInWithEthereumVisualizerParams = {
	signInRequest: VisualizedPersonalSignRequestSignInWithEthereum
	renameAddressCallBack: RenameAddressCallBack
}

// EIP-4361 requires the scheme, domain, address, statement and resources to be shown by default. The domain, URI and resources are wrapped instead of truncated so a long look-alike domain cannot hide its real ending.
export function SignInWithEthereumVisualizer({ signInRequest, renameAddressCallBack }: SignInWithEthereumVisualizerParams) {
	const { message } = signInRequest
	return <>
		<div class = 'textbox'>
			<ExactValue label = 'Sign in to' value = { getSiweOriginText(message) }/>
			{ message.statement === undefined ? <></> : <ExactValue label = 'Statement' value = { message.statement }/> }
			<ExactValue label = 'URI' value = { message.uri }/>
		</div>
		<span class = 'log-table' style = 'margin-top: 10px; justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			<CellElement text = 'Account: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { signInRequest.signInAccount } renameAddressCallBack = { renameAddressCallBack }/> }/>
			<CellElement text = 'Chain: '/>
			<CellElement text = { getChainNameWithId(message.chainId) }/>
			<CellElement text = 'Nonce: '/>
			<CellElement text = { message.nonce }/>
			<SiweDateTimeRow label = 'Issued at: ' text = { message.issuedAt }/>
			<SiweDateTimeRow label = 'Expires at: ' text = { message.expirationTime }/>
			<SiweDateTimeRow label = 'Not valid before: ' text = { message.notBefore }/>
			{ message.requestId === undefined ? <></> : <>
				<CellElement text = 'Request ID: '/>
				<CellElement text = { message.requestId }/>
			</> }
		</span>
		{ message.resources.length === 0 ? <></> : <div class = 'textbox' style = 'margin-top: 10px'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Resources</p>
			{ message.resources.map((resource, index) => <p key = { index } class = 'paragraph text-legible' style = 'overflow-wrap: anywhere'>{ resource }</p>) }
		</div> }
	</>
}
