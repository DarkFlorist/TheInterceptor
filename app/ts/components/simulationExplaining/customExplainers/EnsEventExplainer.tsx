import type { EnsEvent } from '../../../types/EnrichedEthereumData.js'
import type { RpcNetwork } from '../../../types/rpc.js'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { bigintSecondsToDate, dataStringWith0xStart } from '../../../utils/bigint.js'
import { assertNever } from '../../../utils/typescript.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { Ether } from '../../subcomponents/coins.js'
import { type EditEnsNamedHashCallBack, EnsNamedHashComponent } from '../../subcomponents/ens.js'

type EnsEvenExplainerParam = {
	ensEvent: EnsEvent,
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	rpcNetwork: RpcNetwork,
}

const expiresToDateString = (expires: bigint) => bigintSecondsToDate(expires).toISOString()

const VisualizeEnsEvent = ({ ensEvent, editEnsNamedHashCallBack, renameAddressCallBack, rpcNetwork }: EnsEvenExplainerParam) => {
	switch(ensEvent.subType) {
		case 'ENSAddrChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Change
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
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
				<p class = 'ellipsis paragraph ens-event-text'>
					Register
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `with expiration date of ${ expiresToDateString(ensEvent.logInformation.expires) }` }
				</p>
			</div>
		</div>
		case 'ENSBaseRegistrarNameRenewed': return <></> // the information of this log is already covered in ENSControllerNameRenewed event
		case 'ENSContentHashChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Change ENS content hash of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ dataStringWith0xStart(ensEvent.logInformation.hash) }</p>
				</div>
			</div>
		</div>
		case 'ENSControllerNameRegistered': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Register
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack } addDotEth = { true }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					for
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) } for` }
				</p>
			</div>
			<div class = 'log-cell'>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</div>
		</div>
		case 'ENSControllerNameRenewed': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Renew
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack } addDotEth =  { true }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) } for` }
				</p>
			</div>
			<div class = 'log-cell'>
				<Ether amount = { ensEvent.logInformation.cost } rpcNetwork = { rpcNetwork } fontSize = 'normal'/>
			</div>
		</div>
		case 'ENSExpiryExtended': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Renew
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) }` }
				</p>
			</div>
		</div>
		case 'ENSFusesSet': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					fuses to
				</p>
			</div>
			<div class = 'log-cell ens-event-fuse-list'>
				{ ensEvent.logInformation.fuses.map((fuse) => <>
					<div class = 'textbox ens-event-fuse'>
						<p class = 'paragraph'> { fuse }</p>
					</div>
				</>) }
			</div>
		</div>
		case 'ENSNameChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Change
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `to ${ ensEvent.logInformation.name }` }
				</p>
			</div>
		</div>
		case 'ENSNameUnwrapped': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Unwrap
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
		</div>
		case 'ENSNameWrapped': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Wrap
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `to expire on ${ expiresToDateString(ensEvent.logInformation.expires) } with fuses` }
				</p>
			</div>
			<div class = 'log-cell ens-event-fuse-list'>
				{ ensEvent.logInformation.fuses.map((fuse) => <>
					<div class = 'textbox ens-event-fuse'>
						<p class = 'paragraph'> { fuse }</p>
					</div>
				</>) }
			</div>
		</div>
		case 'ENSNewOwner': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Assign
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.owner } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					as owner of subdomain
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'labelHash' nameHash = { ensEvent.logInformation.labelHash.labelHash } name = { ensEvent.logInformation.labelHash.label } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					under domain
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
		</div>
		case 'ENSNewResolver': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					as a resolver for
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
		</div>
		case 'ENSNewTTL': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Set
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					{ `TTL to ${ ensEvent.logInformation.ttl }` }
				</p>
			</div>
		</div>
		case 'ENSReverseClaimed': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Set ENS reverse address of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					to
				</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress addressBookEntry = { ensEvent.logInformation.address } renameAddressCallBack = { renameAddressCallBack }/>
			</div>
		</div>
		case 'ENSTextChanged': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Change ENS text value of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					for key
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ ensEvent.logInformation.key }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					(
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					)
				</p>
			</div>
		</div>
		case 'ENSTextChangedKeyValue': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Change ENS text value of
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					for key
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ ensEvent.logInformation.key }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					(
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ dataStringWith0xStart(ensEvent.logInformation.indexedKey) }</p>
				</div>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					) to
				</p>
			</div>
			<div class = 'log-cell'>
				<div class = 'textbox text-wrap'>
					<p class = 'paragraph text-subtitle'>{ ensEvent.logInformation.value }</p>
				</div>
			</div>
		</div>
		case 'ENSTransfer': return <div class = 'ens-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
					Transfer
				</p>
			</div>
			<div class = 'log-cell'>
				<EnsNamedHashComponent type = 'nameHash' nameHash = { ensEvent.logInformation.node.nameHash } name = { ensEvent.logInformation.node.name } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis paragraph ens-event-text'>
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
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	rpcNetwork: RpcNetwork,
}

export const getVisibleEnsEvents = (ensEvents: readonly EnsEvent[]) =>
	ensEvents.filter((ensEvent) => ensEvent.subType !== 'ENSAddressChanged' && ensEvent.subType !== 'ENSBaseRegistrarNameRenewed')

// Every ENS event reads as one sentence in its own row; the parts of the sentence wrap as whole pieces.
export function EnsEventsExplainer(param: EnsEvenExplainerParams) {
	return <ul class = 'ens-events'>
		{ getVisibleEnsEvents(param.ensEvents).map((ensEvent, index) =>
			<li key = { `${ ensEvent.subType }-${ index }` } class = 'ens-event'>
				<VisualizeEnsEvent ensEvent = { ensEvent } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/>
			</li>
		) }
	</ul>
}
