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
	const textStyle = `color: ${ textColor }; margin-bottom: 0px; display: inline-block`
	switch(ensEvent.subType) {
		case 'ENSAddrChanged': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Changes ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to resolve as
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.to } renameAddressCallBack = { renameAddressCallBack }/>
		</div>
		case 'ENSAddressChanged': return <></>
		case 'ENSBaseRegistrarNameRegistered': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Register ENS name
			</p>
			<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `with expiration date of ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
			</p>
		</div>
		case 'ENSBaseRegistrarNameRenewed': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Renew ENS name
			</p>
			<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
			</p>
		</div>
		case 'ENSContentHashChanged': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Change ENS content hash of 
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.hash) }</p>
			</div>
		</div>
		case 'ENSControllerNameRegistered': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `Register ENS name ${ ensEvent.logInformation.name }` } 
			</p>
			<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>

			<p class = 'ellipsis paragraph' style = { textStyle }>
				for
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>

			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() } for` } 
			</p>
			<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
		</div>
		case 'ENSControllerNameRenewed': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `Renew ENS name ${ ensEvent.logInformation.name }` } 
			</p>
			<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() } for` } 
			</p>
			<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
		</div>
		case 'ENSExpiryExtended': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Extend ENS domain
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() }` } 
			</p>
		</div>
		case 'ENSFusesSet': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Set ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				fuses to
			</p>
			{ ensEvent.logInformation.fuses.map((fuse) => {
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ fuse }</p>
				</div>
			}) }
		</div>
		case 'ENSNameChanged': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Change ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to ${ ensEvent.logInformation.name }` }
			</p>
		</div>
		case 'ENSNameUnwrapped': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Unwrap ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
		</div>
		case 'ENSNameWrapped': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `Wrap ENS name ${ ensEvent.logInformation.name }` } 
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `to expire in ${ (new Date(Number(ensEvent.logInformation.expires))).getUTCDate() } with fuses` } 
			</p>
			{ ensEvent.logInformation.fuses.map((fuse) => {
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ fuse }</p>
				</div>
			}) }
		</div>
		case 'ENSNewOwner': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Assign ENS name
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				as owner of subdomain
			</p>
			<EnsNamedHashComponent type = { 'labelHash' } nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				under domain
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
		</div>
		case 'ENSNewResolver': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Set ENS name
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				as a resolver for
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
		</div>
		case 'ENSNewTTL': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Set ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				{ `TTL to ${ ensEvent.logInformation.ttl }` }
			</p>
		</div>
		case 'ENSReverseClaimed': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Set ENS reverse address of 
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
		</div>
		case 'ENSTextChanged': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Change ENS text value of
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				for key
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.key }</p>
			</div>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				(
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
			</div>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				)
			</p>
		</div>
		case 'ENSTextChangedKeyValue': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Change ENS text value of
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				for key
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.key }</p>
			</div>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				(
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
			</div>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				) to
			</p>
			<div class = 'textbox' style = 'white-space: normal;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.value }</p>
			</div>
		</div>
		case 'ENSTransfer': return <div class = 'priority-line'>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				Transfer ENS name
			</p>
			<EnsNamedHashComponent type = { 'nameHash' } nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			<p class = 'ellipsis paragraph' style = { textStyle }>
				to
			</p>
			<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
		</div>
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
				<div class = { `box token-box vertical-center positive-box` } style = 'display: inline-block'>
					<VisualizeEnsEvent ensEvent = { ensEvent } textColor = { param.textColor } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/>
				</div>
			</div>
		) }
	</>
}