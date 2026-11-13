import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { BlockExplorer } from '../types/rpc.js'
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

export const networkPriceSources = {
	uniswapV2Like: [
		{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2
	],
	uniswapV3Like: [
		{ factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984n, initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' } // Uniswap V3
	]
} as const

export const getDefaultBlockExplorer = (): BlockExplorer => ({ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8' })
