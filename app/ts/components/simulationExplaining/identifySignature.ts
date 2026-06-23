import type { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { addressString } from '../../utils/bigint.js'
import { assertNever } from '../../utils/typescript.js'

function getPermitTokenLabel(entry: AddressBookEntry) {
	const symbol = entry.type === 'ERC20' ? entry.symbol.trim() : ''
	if (symbol !== '') return symbol
	const name = entry.name.trim()
	if (name !== '') return name
	return addressString(entry.address)
}

export function identifySignature(data: VisualizedPersonalSignRequest) {
	switch (data.type) {
		case 'OrderComponents': return {
			title: 'Opensea order',
			rejectAction: 'Reject Opensea order',
			simulationAction: 'Simulate Opensea order',
			signingAction: 'Sign Opensea order',
		}
		case 'SafeTx': return {
			title: 'Gnosis Safe message',
			rejectAction: 'Reject Gnosis Safe message',
			simulationAction: 'Simulate Gnosis Safe message',
			signingAction: 'Sign Gnosis Safe message',
		}
		case 'EIP712': {
			const { name: domainName } = data.message.domain
			const name = domainName?.type === 'string' ? `${ domainName.value } - ${ data.message.primaryType }` : 'Arbitrary EIP712 message'
			return {
				title: `${ name } signing request`,
				rejectAction: `Reject ${ name }`,
				simulationAction: `Simulate ${ name }`,
				signingAction: `Sign ${ name }`,
			}
		}
		case 'NotParsed': return {
			title: 'Arbitrary Ethereum message',
			rejectAction: 'Reject arbitrary message',
			simulationAction: 'Simulate arbitrary message',
			signingAction: 'Sign arbitrary message',
		}
		case 'Permit': {
			const tokenLabel = getPermitTokenLabel(data.verifyingContract)
			return {
				title: `${ tokenLabel } Permit`,
				signingAction: `Sign ${ tokenLabel } Permit`,
				simulationAction: `Simulate ${ tokenLabel } Permit`,
				rejectAction: `Reject ${ tokenLabel } Permit`,
				to: data.spender
			}
		}
		case 'Permit2': {
			const tokenLabel = getPermitTokenLabel(data.token)
			return {
				title: `${ tokenLabel } Permit`,
				signingAction: `Sign ${ tokenLabel } Permit`,
				simulationAction: `Simulate ${ tokenLabel } Permit`,
				rejectAction: `Reject ${ tokenLabel } Permit`,
				to: data.spender
			}
		}
		default: assertNever(data)
	}
}
