import { RpcNetwork } from '../../../types/rpc.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { EnsEvent } from '../../../types/visualizer-types.js'
import { dataStringWith0xStart } from '../../../utils/bigint.js'
import { assertNever } from '../../../utils/typescript.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { Ether } from '../../subcomponents/coins.js'
import { EditEnsNamedHashCallBack, EnsNamedHashComponent } from '../../subcomponents/ens.js'

type EnsEvenExplainerParam = {
	ensEvent: EnsEvent,
	textColor: string,
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	rpcNetwork: RpcNetwork,
}

const VisualizeEnsEvent = ({ ensEvent, textColor, editEnsNamedHashCallBack, renameAddressCallBack, rpcNetwork }: EnsEvenExplainerParam) => {
	switch(ensEvent.subType) {
		case 'ENSAddrChanged': return <>
			<table class = 'log-table-4'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Changes
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						to resolve to
					</p>
				</div>
				<div class = 'log-cell'>
					<SmallAddress addressBookEntry = { ensEvent.logInformation.to } renameAddressCallBack = { renameAddressCallBack }/>
				</div>
			</table>
		</>
		case 'ENSAddressChanged': return <></>
		case 'ENSBaseRegistrarNameRegistered': return <>
			<table class = 'log-table'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Register name
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						to
					</p>
				</div>
				<div class = 'log-cell'>
					<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `with expiration date of ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
					</p>
				</div>
			</table>
		</>
		case 'ENSBaseRegistrarNameRenewed': return <>
			<table class = 'log-table-3'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Renew name
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
					</p>
				</div>
			</table>
		</>
		case 'ENSContentHashChanged': return <>
			<table class = 'log-table-4'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Change content hash of 
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						to
					</p>
				</div>
				<div class = 'log-cell'>
					<div class = 'textbox' style = 'white-space: normal;'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.hash) }</p>
					</div>
				</div>
			</table>
		</>
		case 'ENSControllerNameRegistered': return <>
			<table class = 'log-table-8'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `Register name ${ ensEvent.logInformation.name }` } 
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						for
					</p>
				</div>
				<div class = 'log-cell'>
					<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
					</p>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `for` } 
					</p>
				</div>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</table>
		</>
		case 'ENSControllerNameRenewed': return <>
			<table class = 'log-table-6'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `Renew name ${ ensEvent.logInformation.name }` } 
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
					</p>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `for` } 
					</p>
				</div>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</table>
		</>
		case 'ENSExpiryExtended': return <>
			<table class = 'log-table-3'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Extend
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
					</p>
				</div>
			</table>
		</>
		case 'ENSFusesSet': return <>
			<table class = 'log-table-3'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Set
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						fuses to
					</p>
				</div>
				<div class = 'log-cell'>
					{ ensEvent.logInformation.fuses.map((fuse) => {
						<div class = 'textbox' style = 'white-space: normal;'>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ fuse }</p>
						</div>
					}) }
				</div>
			</table>
		</>
		case 'ENSNameChanged': return <>
			<table class = 'log-table-3'>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						Change name
					</p>
				</div>
				<div class = 'log-cell'>
					<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						to
					</p>
				</div>
				<div class = 'log-cell'>
					<p class = 'ellipsis paragraph' style = { `color: ${ textColor }; margin-bottom: 0px; display: inline-block` }>
						{ ensEvent.logInformation.name }
					</p>
				</div>
			</table>
		</>
		case 'ENSNameUnwrapped': return <p>ENSNameUnwrapped</p>
		case 'ENSNameWrapped': return <p>ENSNameWrapped</p>
		case 'ENSNewOwner': return <p>ENSNewOwner</p>
		case 'ENSNewResolver': return <p>ENSNewResolver</p>
		case 'ENSNewTTL': return <p>ENSNewTTL</p>
		case 'ENSReverseClaimed': return <p>ENSReverseClaimed</p>
		case 'ENSTextChanged': return <p>ENSTextChanged</p>
		case 'ENSTextChangedKeyValue': return <p>ENSTextChangedKeyValue</p>
		case 'ENSTransfer': return <p>ENSTransfer</p>
		default: assertNever(ensEvent)
	}
}

type EnsEvenExplainerParams = {
	ensEvents: readonly EnsEvent[],
	textColor: string,
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	rpcNetwork: RpcNetwork,
}

export function EnsEventsExplainer(param: EnsEvenExplainerParams) {
	return <>
		{ param.ensEvents.filter((ensEvent) => ensEvent.subType !== 'ENSAddressChanged').map((ensEvent) =>
			<div class = 'vertical-center'>
				<div class = { `box token-box vertical-center` } style = 'display: inline-block'>
					<VisualizeEnsEvent ensEvent = { ensEvent } textColor = { param.textColor } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/>
				</div>
			</div>
		) }
	</>
}