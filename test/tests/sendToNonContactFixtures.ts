import type { IdentifyAddress } from '../../app/ts/simulation/fundsDestinations.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../../app/ts/types/addressBookTypes.js'
import type { EnrichedEthereumEvent } from '../../app/ts/types/EnrichedEthereumData.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'

export const sender: AddressBookEntry = {
	type: 'contact',
	name: 'Sender',
	address: 0x1111111111111111111111111111111111111111n,
	entrySource: 'User',
}

export const proxy: AddressBookEntry = {
	type: 'contract',
	name: 'Unknown proxy',
	address: 0x2222222222222222222222222222222222222222n,
	entrySource: 'OnChain',
}

export const nativeToken: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Ether',
	symbol: 'ETH',
	decimals: 18n,
	address: ETHEREUM_LOGS_LOGGER_ADDRESS,
	entrySource: 'Interceptor',
}

export const erc20Token: Erc20TokenEntry = {
	type: 'ERC20',
	name: 'Token',
	symbol: 'TKN',
	decimals: 18n,
	address: 0x7777777777777777777777777777777777777777n,
	entrySource: 'User',
}

// Each suite passes every entry its transactions touch, and any other address throws so an unexpected lookup fails the test.
export const createIdentifyAddress = (entries: readonly AddressBookEntry[]): IdentifyAddress => {
	const entriesByAddress = new Map(entries.map((entry) => [entry.address, entry]))
	return async (address) => {
		const entry = entriesByAddress.get(address)
		if (entry === undefined) throw new Error(`Missing test address ${ address }`)
		return entry
	}
}

// Defaults to a mainnet ether send from the sender to the proxy without calldata.
export const createTransaction = ({ input = new Uint8Array(), value = 100n, to = proxy.address }: {
	input?: Uint8Array
	value?: bigint
	to?: bigint
} = {}): EthereumUnsignedTransaction => ({
	type: '1559',
	from: sender.address,
	nonce: 1n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 100_000n,
	to,
	value,
	input,
	chainId: 1n,
})

export const createTransferEvent = ({ from, to, amount, token = nativeToken }: {
	from: AddressBookEntry
	to: AddressBookEntry
	amount: bigint
	token?: Erc20TokenEntry
}): EnrichedEthereumEvent => ({
	type: 'TokenEvent',
	isParsed: 'Parsed',
	name: 'Transfer',
	signature: 'Transfer(address,address,uint256)',
	args: [],
	address: token.address,
	loggersAddressBookEntry: token,
	data: new Uint8Array(),
	topics: [],
	logInformation: {
		type: 'ERC20',
		from: from.address,
		to: to.address,
		tokenAddress: token.address,
		amount,
		isApproval: false,
	},
})
