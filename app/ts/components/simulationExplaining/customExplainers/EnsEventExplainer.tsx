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

const expiresToDateString = (expires: bigint) => (new Date(Number(expires) * 1000)).toISOString()

const VisualizeEnsEvent = ({ ensEvent, textColor, editEnsNamedHashCallBack, renameAddressCallBack, rpcNetwork }: EnsEvenExplainerParam) => {
	const textStyle = `color: ${ textColor }; margin-bottom: 0px; display: inline-block`
	switch(ensEvent.subType) {
		case 'ENSAddrChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Change
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to resolve as
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.to } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
		</div>
		case 'ENSAddressChanged': return <></>
		case 'ENSBaseRegistrarNameRegistered': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Register
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `with expiration date of ${ expiresToDateString(ensEvent.logInformation.expires) }` } 
				</p>
			</div>
		</div>
		case 'ENSBaseRegistrarNameRenewed': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Renew
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) }` } 
				</p>
			</div>
		</div>
		case 'ENSContentHashChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Change ENS content hash of 
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.hash) }</p>
				</div>
			</div>
		</div>
		case 'ENSControllerNameRegistered': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `Register ${ ensEvent.logInformation.name }` } 
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					for
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) } for` } 
				</p>
			</div>
			<div class = 'log-cell'>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</div>
		</div>
		case 'ENSControllerNameRenewed': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `Renew ${ ensEvent.logInformation.name }` } 
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) } for` } 
				</p>
			</div>
			<div class = 'log-cell'>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</div>
		</div>
		case 'ENSExpiryExtended': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Extend domain
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) }` } 
				</p>
			</div>
		</div>
		case 'ENSFusesSet': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
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
		</div>
		case 'ENSNameChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Change
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to ${ ensEvent.logInformation.name }` }
				</p>
			</div>
		</div>
		case 'ENSNameUnwrapped': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Unwrap
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
		</div>
		case 'ENSNameWrapped': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `Wrap ${ ensEvent.logInformation.name }` } 
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `to expire on ${ (new Date(Number(ensEvent.logInformation.expires))).toISOString() } with fuses` } 
				</p>
			</div>
			<div class = 'log-cell'>
				{ ensEvent.logInformation.fuses.map((fuse) => {
					<div class = 'textbox' style = 'white-space: normal;'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ fuse }</p>
					</div>
				}) }
			</div>
		</div>
		case 'ENSNewOwner': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Assign
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					as owner of subdomain
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					under domain
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
		</div>
		case 'ENSNewResolver': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					as a resolver for
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
		</div>
		case 'ENSNewTTL': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					{ `TTL to ${ ensEvent.logInformation.ttl }` }
				</p>
			</div>
		</div>
		case 'ENSReverseClaimed': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Set ENS reverse address of 
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
		</div>
		case 'ENSTextChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Change ENS text value of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					for key
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.key }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					(
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					)
				</p>
			</div>
		</div>
		case 'ENSTextChangedKeyValue': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Change ENS text value of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					for key
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.key }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					(
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					) to
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox' style = 'white-space: normal;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ ensEvent.logInformation.value }</p>
				</div>
			</div>
		</div>
		case 'ENSTransfer': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					Transfer
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph' style = { textStyle }>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
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
				<div class = 'box token-box vertical-center positive-box' style = 'display: inline-block'>
					<VisualizeEnsEvent ensEvent = { ensEvent } textColor = { param.textColor } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/>
				</div>
			</div>
		) }
	</>
}
