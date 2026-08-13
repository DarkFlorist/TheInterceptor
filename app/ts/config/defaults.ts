import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { ETHEREUM_COIN_ICON, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'

export const DEFAULT_ACTIVE_ADDRESSES: AddressBookEntries = [
	{
		type: 'contact',
		entrySource: 'User',
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
		useAsActiveAddress: true,
		chainId: 'AllChains',
	},
	{
		type: 'contact',
		entrySource: 'User',
		name: 'Public private key',
		address: MOCK_PRIVATE_KEYS_ADDRESS,
		askForAddressAccess: false,
		useAsActiveAddress: true,
		chainId: 'AllChains',
	},
]

export const DEFAULT_RPCS = [
	{
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://ethereum.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
	},
] as const

export const DEFAULT_BLOCK_MANIPULATION = {
	type: 'AddToTimestamp',
	deltaToAdd: 12n,
	deltaUnit: 'Seconds',
} as const satisfies BlockTimeManipulation
