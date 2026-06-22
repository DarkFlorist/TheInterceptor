import type { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import { assertNever } from '../../utils/typescript.js'

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
			const symbol = data.verifyingContract
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.spender
			}
		}
		case 'Permit2': {
			const symbol = 'symbol' in data.token ? data.token.symbol : '???'
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.spender
			}
		}
		default: assertNever(data)
	}
}
