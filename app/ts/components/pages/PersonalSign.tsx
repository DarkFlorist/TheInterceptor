import { useState, useEffect } from 'preact/hooks'
import { dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { AddingNewAddressType, AddressBookEntry, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { ErrorCheckBox, Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { ExternalPopupMessage } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { assertNever } from '../../utils/typescript.js'
import { SimpleTokenApprovalVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { QuarantineCodes } from '../simulationExplaining/Transactions.js'
import { PersonalSignRequestData, PersonalSignRequestDataPermit, PersonalSignRequestDataPermit2, PersonalSignRequestDataSafeTx } from '../../utils/personal-message-definitions.js'
import { OrderComponents, OrderComponentsExtraDetails } from '../simulationExplaining/customExplainers/OpenSeaOrder.js'
import { Ether } from '../subcomponents/coins.js'
import { EnrichedEIP712, EnrichedEIP712Message, GroupedSolidityType } from '../../utils/eip712Parsing.js'
import { tryFocusingTabOrWindow, humanReadableDateFromSeconds, CellElement } from '../ui-utils.js'

type SignatureCardParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

type SignatureHeaderParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

function identifySignature(data: PersonalSignRequestData) {
	switch (data.type) {
		case 'OrderComponents': return {
			title: 'Opensea order',
			rejectAction: 'Reject Opensea order',
			simulationAction: 'Simulate Opensea order',
			signingAction: 'Sign Opensea order',
		}
		case 'SafeTx': return {
			title: 'Arbitary Gnosis Safe message signing request',
			rejectAction: 'Reject Gnosis Safe message',
			simulationAction: 'Simulate Gnosis Safe message',
			signingAction: 'Sign Gnosis Safe message',
		}
		case 'EIP712': {
			const name = data.message.domain.name?.type === 'string' ? data.message.domain.name.value : 'Arbitary EIP712 message'
			return {
				title: `${ name } signing request`,
				rejectAction: `Reject ${ name }`,
				simulationAction: `Simulate ${ name }`,
				signingAction: `Sign ${ name }`,
			}
		}
		case 'NotParsed': return {
			title: 'Arbitary Ethereum message signing request',
			rejectAction: 'Reject arbitary message',
			simulationAction: 'Simulate arbitary message',
			signingAction: 'Sign arbitary message',
		}
		case 'Permit': {
			const symbol = data.addressBookEntries.verifyingContract
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.addressBookEntries.spender
			}
		}
		case 'Permit2': {
			const symbol = data.addressBookEntries.token.symbol
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.addressBookEntries.spender
			}
		}
		default: assertNever(data)
	}
}

function SignatureHeader(params: SignatureHeaderParams) {
	return <header class = 'card-header' style = 'height: 40px;'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { params.personalSignRequestData.simulationMode ? '../img/head-simulating.png' : '../img/head-signing.png' } />
			</span>
		</div>

		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifySignature(params.personalSignRequestData).title }
		</p>
		<p class = 'card-header-icon' style = 'margin-left: auto; margin-right: 0; padding-right: 10px; padding-left: 0px; overflow: hidden'>
			{'addressBookEntries' in params.personalSignRequestData && 'spender' in params.personalSignRequestData.addressBookEntries ?
				<SmallAddress
					addressBookEntry = { params.personalSignRequestData.addressBookEntries.spender }
					renameAddressCallBack = { params.renameAddressCallBack }
					style = { { 'background-color': 'unset' } }
				/>
			: <></>}
		</p>
	</header>
}

type SignRequestParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

function SignRequest({ personalSignRequestData, renameAddressCallBack }: SignRequestParams) {
	switch (personalSignRequestData.type) {
		case 'NotParsed': {
			if (personalSignRequestData.originalParams.method === 'personal_sign') {
				return <>
					<p class = 'paragraph'>Raw message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ personalSignRequestData.message }</p>
					</div>
					<p class = 'paragraph'>Text decoded message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ new TextDecoder().decode(stringToUint8Array(personalSignRequestData.message)) }</p>
					</div>
				</>
			}
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ personalSignRequestData.message }</p>
			</div>
		}
		
		case 'SafeTx': return <SafeTx
			personalSignRequestDataSafeTx = { personalSignRequestData }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'EIP712': {
			return <ArbitaryEIP712 enrichedEIP712 = { personalSignRequestData.message } renameAddressCallBack = { renameAddressCallBack } />
		}
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { personalSignRequestData.message }
				rpcNetwork = { personalSignRequestData.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit': {
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'Token',
					from: personalSignRequestData.account,
					to: personalSignRequestData.addressBookEntries.spender,
					token: personalSignRequestData.addressBookEntries.verifyingContract,
					amount: personalSignRequestData.message.message.value,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { personalSignRequestData.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit2': {
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'Token',
					token: personalSignRequestData.addressBookEntries.token,
					amount: personalSignRequestData.message.message.details.amount,
					from: personalSignRequestData.account,
					to: personalSignRequestData.addressBookEntries.spender,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { personalSignRequestData.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		default: assertNever(personalSignRequestData)
	}
}

function SafeTx({ personalSignRequestDataSafeTx, renameAddressCallBack }: { personalSignRequestDataSafeTx: PersonalSignRequestDataSafeTx, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			{ personalSignRequestDataSafeTx.message.domain.chainId !== undefined
				? <>
					<CellElement text = 'Chain: '/>
					<CellElement text = { getChainName(BigInt(personalSignRequestDataSafeTx.message.domain.chainId)) }/>
				</>
				: <></>
			}
			<CellElement text = 'baseGas: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.baseGas }/>
			<CellElement text = 'gasPrice: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.gasPrice }/>
			{ personalSignRequestDataSafeTx.message.message.gasToken !== 0n
				? <>
					<CellElement text = 'gasToken: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'nonce: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.nonce }/>
			<CellElement text = 'operation: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.operation }/>
			{ personalSignRequestDataSafeTx.message.message.refundReceiver !== 0n ?
				<>
					<CellElement text = 'refundReceiver: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'safeTxGas: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.safeTxGas }/>
			<CellElement text = 'to: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'value: '/>
			<CellElement text = { <Ether amount = { personalSignRequestDataSafeTx.message.message.value } rpcNetwork = { personalSignRequestDataSafeTx.rpcNetwork }/>  }/>
		</span>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw transaction input: </p>
		<div class = 'textbox'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(personalSignRequestDataSafeTx.message.message.data) }</p>
		</div>
	</>
}

function visualizeEIP712Component(valueType: GroupedSolidityType, renameAddressCallBack: RenameAddressCallBack) {
	switch(valueType.type) {
		case 'address': return <SmallAddress addressBookEntry = { valueType.value } renameAddressCallBack = { renameAddressCallBack } />
		case 'bool': return valueType.value
		case 'bytes': return <div class = 'textbox' style = 'white-space: normal;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(valueType.value) }</p> </div>
		case 'fixedBytes': return dataStringWith0xStart(valueType.value)
		case 'integer': return valueType.value
		case 'string': return valueType.value
		case 'address[]': return valueType.value.map((value) => <SmallAddress addressBookEntry = { value } renameAddressCallBack = { renameAddressCallBack } />)
		case 'bool[]': return `[ ${valueType.value.toString() }]`
		case 'bytes[]':  return valueType.value.map((value) => <div class = 'textbox' style = 'white-space: normal;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(value) }</p> </div>)
		case 'fixedBytes[]': return `[ ${valueType.value.toString() }]`
		case 'integer[]': return `[ ${valueType.value.toString() }]`
		case 'string[]': return `[ ${valueType.value.toString() }]`
		default: assertNever(valueType)
	}
}
type EIP712Table = {
	enrichedEIP712Message: EnrichedEIP712Message
	renameAddressCallBack: RenameAddressCallBack
	isSubTable: boolean
}

function EIP712Table({ enrichedEIP712Message, renameAddressCallBack, isSubTable }: EIP712Table) {
	return <span class = 'eip-712-table' style = { isSubTable ? 'justify-content: space-between;' : '' }>
		<>{ Object.entries(enrichedEIP712Message).map(([key, entry]) => <>
			{ entry === undefined
				? <></>
				: <>
					<CellElement text = { `${ key }: ` }/>
					{ entry.type === 'record' || entry.type === 'record[]' ?
						entry.type === 'record[]' ?
							<CellElement text = { entry.value.map((value) => <EIP712Table enrichedEIP712Message = { value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>) } />
							: <CellElement text = { <EIP712Table enrichedEIP712Message = { entry.value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>
						} />
						: <CellElement text = { visualizeEIP712Component(entry, renameAddressCallBack) }/>
					}
				</>
			}
		</>) } </>
	</span>
}

type ArbitaryEIP712Params = {
	enrichedEIP712: EnrichedEIP712
	renameAddressCallBack: RenameAddressCallBack
}

function ArbitaryEIP712({ enrichedEIP712, renameAddressCallBack }: ArbitaryEIP712Params) {
	return <>
		<EIP712Table 
			enrichedEIP712Message = { enrichedEIP712.domain }
			renameAddressCallBack = { renameAddressCallBack }
			isSubTable = { false }
		/>
		<EIP712Table 
			enrichedEIP712Message = { enrichedEIP712.message }
			renameAddressCallBack = { renameAddressCallBack }
			isSubTable = { false }
		/>
	</>
}

export function Permit2ExtraDetails({ permit2 }: { permit2: PersonalSignRequestDataPermit2 }) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(BigInt(permit2.message.domain.chainId)) }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit2.message.message.details.nonce.toString(10) }/>
		<CellElement text = 'Signature expires  in:'/>
		<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(permit2.message.message.sigDeadline) * 1000) } countBackwards = { true }/> }/>
		<CellElement text = 'Spender can spend for:'/>
		<CellElement text = { <>
			<SomeTimeAgo priorTimestamp = { new Date(Number(permit2.message.message.details.expiration) * 1000) } countBackwards = { true }/>
			{` (until ${ humanReadableDateFromSeconds(permit2.message.message.details.expiration) })`}
		</> }/>
	</>
}

export function PermitExtraDetails({ permit }: { permit: PersonalSignRequestDataPermit }) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(BigInt(permit.message.domain.chainId)) }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit.message.message.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in:'/>
		<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(permit.message.message.deadline) * 1000) } countBackwards = { true }/> }/>		
	</>
}

type ExtraDetailsCardParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

export function ExtraDetails({ personalSignRequestData, renameAddressCallBack }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(true)

	if (personalSignRequestData.type !== 'Permit2'
		&& personalSignRequestData.type !== 'Permit'
		&& personalSignRequestData.type !== 'OrderComponents') {
		return <></>
	}

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Extra details
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <>
				<div class = 'card-content'>
					<div class = 'container' style = 'margin-bottom: 10px;'>
						<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
							{ personalSignRequestData.type !== 'Permit2' ? <></> : <Permit2ExtraDetails permit2 = { personalSignRequestData }/> }
							{ personalSignRequestData.type !== 'Permit' ? <></> : <PermitExtraDetails permit = { personalSignRequestData }/> }
							{ personalSignRequestData.type !== 'OrderComponents' ? <></> : <OrderComponentsExtraDetails orderComponents = { personalSignRequestData.message } renameAddressCallBack = { renameAddressCallBack }/> }
						</span>
					</div>
				</div>
			</>
		}
	</div>
}

function SignatureCard(params: SignatureCardParams) {
	return <>
		<div class = 'card' style = 'margin: 10px;'>
			<SignatureHeader { ...params }/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<SignRequest { ...params }/>
					<QuarantineCodes quarantineCodes = { params.personalSignRequestData.quarantineCodes }/>
				</div>
				<ExtraDetails { ...params }/>
			</div>
		</div>
	</>
}

export function PersonalSign() {
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [personalSignRequestData, setPersonalSignRequestData] = useState<PersonalSignRequestData | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)

	useEffect(() => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_personal_sign_request') return
			setPersonalSignRequestData(message.data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_personalSignReadyAndListening' }) }, [])

	function refreshMetadata() {
		if (personalSignRequestData === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshPersonalSignMetadata', data: personalSignRequestData })
	}

	async function approve() {
		if (personalSignRequestData === undefined) throw new Error('personalSignRequestData is missing')
		await tryFocusingTabOrWindow({ type: 'tab', id: personalSignRequestData.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSign', data: { uniqueRequestIdentifier: personalSignRequestData.request.uniqueRequestIdentifier, accept: true } })
	}

	async function reject() {
		if (personalSignRequestData === undefined) throw new Error('personalSignRequestData is missing')
		await tryFocusingTabOrWindow({ type: 'tab', id: personalSignRequestData.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSign', data: { uniqueRequestIdentifier: personalSignRequestData.request.uniqueRequestIdentifier, accept: false } })
	}

	function isPossibleToSend(personalSignRequestData: PersonalSignRequestData, activeAddress: bigint) {
		return !(personalSignRequestData.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.originalParams.method !== 'personal_sign'))
	}

	function isConfirmDisabled(personalSignRequestData: PersonalSignRequestData, activeAddress: bigint) {
		return !isPossibleToSend(personalSignRequestData, activeAddress) && !forceSend
	}
	
	function Buttons() {
		if (personalSignRequestData === undefined) return <></>
		const identified = identifySignature(personalSignRequestData)
	
		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right'
				onClick = { approve }
				disabled = { isConfirmDisabled(personalSignRequestData, personalSignRequestData.activeAddress.address) }>
				{ personalSignRequestData.simulationMode
					? `${ identified.simulationAction }!`
					: <SignerLogoText { ...{ signerName: personalSignRequestData.signerName, text: identified.signingAction, } }/>
				}
			</button>
		</div>
	}
	

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	if (personalSignRequestData === undefined) return <CenterToPageTextSpinner text = 'Visualizing...'/>
	
	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed'
						? <></>
						: <AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addingNewAddress = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
					<div style = 'overflow-y: auto'>
						<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
							<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden;'>
								<WebsiteOriginText { ...personalSignRequestData.website } />
							</div>
							<p class = 'card-header-title' style = 'overflow: hidden; font-weight: unset; flex-direction: row-reverse;'>
								{ personalSignRequestData.activeAddress === undefined ? <></> : <SmallAddress
									addressBookEntry = { personalSignRequestData.activeAddress }
									renameAddressCallBack = { renameAddressCallBack }
								/> }
							</p>
						</header>
						<SignatureCard
							personalSignRequestData = { personalSignRequestData }
							renameAddressCallBack = { renameAddressCallBack }
						/>
					</div>

					<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
						
						{ isPossibleToSend(personalSignRequestData, personalSignRequestData.activeAddress.address) && personalSignRequestData.quarantine
							? <div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
							: <></>
						}
						{ personalSignRequestData.simulationMode && (personalSignRequestData.activeAddress.address === undefined || personalSignRequestData.activeAddress.address !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.originalParams.method != 'personal_sign')
							? <div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorComponent text = 'Unfortunately we cannot simulate message signing as it requires private key access 😢.'/>
								</div>
							</div>
							: <></>
						}
						<Buttons/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
