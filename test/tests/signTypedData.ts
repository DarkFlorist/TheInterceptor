import { Permit2, SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import { extractEIP712Message, validateEIP712Types } from '../../app/ts/utils/eip712Parsing.js'
import * as assert from 'assert'
import { stringifyJSONWithBigInts } from '../../app/ts/utils/bigint.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'

export async function main() {
	const permit2Message = `{
		"types": {
			"PermitSingle": [
				{
					"name": "details",
					"type": "PermitDetails"
				},
				{
					"name": "spender",
					"type": "address"
				},
				{
					"name": "sigDeadline",
					"type": "uint256"
				}
			],
			"PermitDetails": [
				{
					"name": "token",
					"type": "address"
				},
				{
					"name": "amount",
					"type": "uint160"
				},
				{
					"name": "expiration",
					"type": "uint48"
				},
				{
					"name": "nonce",
					"type": "uint48"
				}
			],
			"EIP712Domain": [
				{
					"name": "name",
					"type": "string"
				},
				{
					"name": "chainId",
					"type": "uint256"
				},
				{
					"name": "verifyingContract",
					"type": "address"
				}
			]
		},
		"domain": {
			"name": "Permit2",
			"chainId": "1",
			"verifyingContract": "0x000000000022d473030f116ddee9f6b43ac78ba3"
		},
		"primaryType": "PermitSingle",
		"message": {
			"details": {
				"token": "0xdac17f958d2ee523a2206206994597c13d831ec7",
				"amount": "1461501637330902918203684832716283019655932542975",
				"expiration": "1677335407",
				"nonce": "0"
			},
			"spender": "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
			"sigDeadline": "1674745207"
		}
	}`

	const permit2MessageHexChainId = `{
		"types": {
			"PermitSingle": [
				{
					"name": "details",
					"type": "PermitDetails"
				},
				{
					"name": "spender",
					"type": "address"
				},
				{
					"name": "sigDeadline",
					"type": "uint256"
				}
			],
			"PermitDetails": [
				{
					"name": "token",
					"type": "address"
				},
				{
					"name": "amount",
					"type": "uint160"
				},
				{
					"name": "expiration",
					"type": "uint48"
				},
				{
					"name": "nonce",
					"type": "uint48"
				}
			],
			"EIP712Domain": [
				{
					"name": "name",
					"type": "string"
				},
				{
					"name": "chainId",
					"type": "uint256"
				},
				{
					"name": "verifyingContract",
					"type": "address"
				}
			]
		},
		"domain": {
			"name": "Permit2",
			"chainId": "0x1",
			"verifyingContract": "0x000000000022d473030f116ddee9f6b43ac78ba3"
		},
		"primaryType": "PermitSingle",
		"message": {
			"details": {
				"token": "0xdac17f958d2ee523a2206206994597c13d831ec7",
				"amount": "1461501637330902918203684832716283019655932542975",
				"expiration": "1677335407",
				"nonce": "0"
			},
			"spender": "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
			"sigDeadline": "1674745207"
		}
	}`

	const permit2MessageNumberChainId = `{
		"types": {
			"PermitSingle": [
				{
					"name": "details",
					"type": "PermitDetails"
				},
				{
					"name": "spender",
					"type": "address"
				},
				{
					"name": "sigDeadline",
					"type": "uint256"
				}
			],
			"PermitDetails": [
				{
					"name": "token",
					"type": "address"
				},
				{
					"name": "amount",
					"type": "uint160"
				},
				{
					"name": "expiration",
					"type": "uint48"
				},
				{
					"name": "nonce",
					"type": "uint48"
				}
			],
			"EIP712Domain": [
				{
					"name": "name",
					"type": "string"
				},
				{
					"name": "chainId",
					"type": "uint256"
				},
				{
					"name": "verifyingContract",
					"type": "address"
				}
			]
		},
		"domain": {
			"name": "Permit2",
			"chainId": 1,
			"verifyingContract": "0x000000000022d473030f116ddee9f6b43ac78ba3"
		},
		"primaryType": "PermitSingle",
		"message": {
			"details": {
				"token": "0xdac17f958d2ee523a2206206994597c13d831ec7",
				"amount": "1461501637330902918203684832716283019655932542975",
				"expiration": "1677335407",
				"nonce": "0"
			},
			"spender": "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
			"sigDeadline": "1674745207"
		}
	}`

	const safeTx = `{
		"types": {
			"SafeTx": [
				{
					"type": "address",
					"name": "to"
				},
				{
					"type": "uint256",
					"name": "value"
				},
				{
					"type": "bytes",
					"name": "data"
				},
				{
					"type": "uint8",
					"name": "operation"
				},
				{
					"type": "uint256",
					"name": "safeTxGas"
				},
				{
					"type": "uint256",
					"name": "baseGas"
				},
				{
					"type": "uint256",
					"name": "gasPrice"
				},
				{
					"type": "address",
					"name": "gasToken"
				},
				{
					"type": "address",
					"name": "refundReceiver"
				},
				{
					"type": "uint256",
					"name": "nonce"
				}
			],
			"EIP712Domain": [
				{
					"name": "chainId",
					"type": "uint256"
				},
				{
					"name": "verifyingContract",
					"type": "address"
				}
			]
		},
		"domain": {
			"chainId": "1",
			"verifyingContract": "0x8e160c8e949967d6b797cdf2a2f38f6344a5c95f"
		},
		"primaryType": "SafeTx",
		"message": {
			"to": "0xa01fcd80503365406042456c7be1dd7e35b38f9c",
			"value": "5000000000000000000",
			"data": "0x",
			"operation": "0",
			"safeTxGas": "0",
			"baseGas": "0",
			"gasPrice": "0",
			"gasToken": "0x0000000000000000000000000000000000000000",
			"refundReceiver": "0x0000000000000000000000000000000000000000",
			"nonce": "16"
		}
	}`

	const openSeaWithTotalOriginalConsiderationItems = `{
		"types": {
			"EIP712Domain": [
				{
					"name": "name",
					"type": "string"
				},
				{
					"name": "version",
					"type": "string"
				},
				{
					"name": "chainId",
					"type": "uint256"
				},
				{
					"name": "verifyingContract",
					"type": "address"
				}
			],
			"OrderComponents": [
				{
					"name": "offerer",
					"type": "address"
				},
				{
					"name": "zone",
					"type": "address"
				},
				{
					"name": "offer",
					"type": "OfferItem[]"
				},
				{
					"name": "consideration",
					"type": "ConsiderationItem[]"
				},
				{
					"name": "orderType",
					"type": "uint8"
				},
				{
					"name": "startTime",
					"type": "uint256"
				},
				{
					"name": "endTime",
					"type": "uint256"
				},
				{
					"name": "zoneHash",
					"type": "bytes32"
				},
				{
					"name": "salt",
					"type": "uint256"
				},
				{
					"name": "conduitKey",
					"type": "bytes32"
				},
				{
					"name": "counter",
					"type": "uint256"
				}
			],
			"OfferItem": [
				{
					"name": "itemType",
					"type": "uint8"
				},
				{
					"name": "token",
					"type": "address"
				},
				{
					"name": "identifierOrCriteria",
					"type": "uint256"
				},
				{
					"name": "startAmount",
					"type": "uint256"
				},
				{
					"name": "endAmount",
					"type": "uint256"
				}
			],
			"ConsiderationItem": [
				{
					"name": "itemType",
					"type": "uint8"
				},
				{
					"name": "token",
					"type": "address"
				},
				{
					"name": "identifierOrCriteria",
					"type": "uint256"
				},
				{
					"name": "startAmount",
					"type": "uint256"
				},
				{
					"name": "endAmount",
					"type": "uint256"
				},
				{
					"name": "recipient",
					"type": "address"
				}
			]
		},
		"primaryType": "OrderComponents",
		"domain": {
			"name": "Seaport",
			"version": "1.5",
			"chainId": "1",
			"verifyingContract": "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
		},
		"message": {
			"offerer": "0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5",
			"offer": [
				{
					"itemType": "1",
					"token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
					"identifierOrCriteria": "0",
					"startAmount": "100000000000000000",
					"endAmount": "100000000000000000"
				}
			],
			"consideration": [
				{
					"itemType": "2",
					"token": "0x79f1C4cF7266746698E91034d658E56913E6644f",
					"identifierOrCriteria": "323",
					"startAmount": "1",
					"endAmount": "1",
					"recipient": "0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5"
				},
				{
					"itemType": "1",
					"token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
					"identifierOrCriteria": "0",
					"startAmount": "2500000000000000",
					"endAmount": "2500000000000000",
					"recipient": "0x0000a26b00c1F0DF003000390027140000fAa719"
				}
			],
			"startTime": "1683538528",
			"endTime": "1683797725",
			"orderType": "0",
			"zone": "0x004C00500000aD104D7DBd00e3ae0A5C00560C00",
			"zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
			"salt": "24446860302761739304752683030156737591518664810215442929802089001070662958770",
			"conduitKey": "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
			"counter": "0"
		}
	}`

	const rpcEntry = {
		name: 'Goerli',
		chainId: 5n,
		httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		currencyName: 'Goerli Testnet ETH',
		currencyTicker: 'GÖETH',
		primary: true,
		minimized: true,
	}

	const ethereum = new EthereumClientService(new MockRequestHandler(), async () => {}, async () => {}, rpcEntry)

	describe('EIP712', () => {
		should('can parse EIP712 message', () => {
			EIP712Message.parse(permit2Message)
		})
		should('can parse Permit2 message', () => {
			Permit2.parse(JSON.parse(permit2Message))
		})
		should('can parse safeTx message', () => {
			SafeTx.parse(JSON.parse(safeTx))
		})

		should('can validate safeTx message', () => {
			const parsed = EIP712Message.parse(safeTx)
			assert.equal(validateEIP712Types(parsed), true)
		})
		should('can validate permit2Message message', () => {
			const parsed = EIP712Message.parse(permit2Message)
			assert.equal(validateEIP712Types(parsed), true)
		})
		should('can validate openSea message', () => {
			const parsed = EIP712Message.parse(openSeaWithTotalOriginalConsiderationItems)
			assert.equal(validateEIP712Types(parsed), true)
		})
		should('can extract safeTx message', async () => {
			const parsed = EIP712Message.parse(safeTx)
			const enrichedMessage = stringifyJSONWithBigInts(await extractEIP712Message(ethereum, undefined, parsed, false))
			const expected = `{"primaryType":"SafeTx","message":{"to":{"type":"address","value":{"address":"0xa01fcd80503365406042456c7be1dd7e35b38f9c","name":"0xA01FCd80503365406042456C7be1DD7E35B38f9c","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"value":{"type":"unsignedInteger","value":"0x4563918244f40000"},"data":{"type":"bytes","value":{}},"operation":{"type":"unsignedInteger","value":"0x0"},"safeTxGas":{"type":"unsignedInteger","value":"0x0"},"baseGas":{"type":"unsignedInteger","value":"0x0"},"gasPrice":{"type":"unsignedInteger","value":"0x0"},"gasToken":{"type":"address","value":{"address":"0x0","name":"0x0 Address","type":"contact","entrySource":"Interceptor","chainId":"0x5"}},"refundReceiver":{"type":"address","value":{"address":"0x0","name":"0x0 Address","type":"contact","entrySource":"Interceptor","chainId":"0x5"}},"nonce":{"type":"unsignedInteger","value":"0x10"}},"domain":{"chainId":{"type":"unsignedInteger","value":"0x1"},"verifyingContract":{"type":"address","value":{"address":"0x8e160c8e949967d6b797cdf2a2f38f6344a5c95f","name":"0x8e160C8E949967D6B797CdF2A2F38f6344a5C95f","type":"contact","entrySource":"OnChain","chainId":"0x5"}}}}`
			assert.equal(enrichedMessage, expected)
		})
		const expectedPermit2 = `{"primaryType":"PermitSingle","message":{"details":{"type":"record","value":{"token":{"type":"address","value":{"name":"Tether","symbol":"USDT","decimals":"0x6","logoUri":"../vendor/@darkflorist/address-metadata/images/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7.png","address":"0xdac17f958d2ee523a2206206994597c13d831ec7","type":"ERC20","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"amount":{"type":"unsignedInteger","value":"0xffffffffffffffffffffffffffffffffffffffff"},"expiration":{"type":"unsignedInteger","value":"0x63fa1b6f"},"nonce":{"type":"unsignedInteger","value":"0x0"}}},"spender":{"type":"address","value":{"address":"0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b","name":"0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"sigDeadline":{"type":"unsignedInteger","value":"0x63d29577"}},"domain":{"name":{"type":"string","value":"Permit2"},"chainId":{"type":"unsignedInteger","value":"0x1"},"verifyingContract":{"type":"address","value":{"name":"Uniswap Permit2","protocol":"Uniswap","logoUri":"../vendor/@darkflorist/address-metadata/images/contracts/uniswap.svg","address":"0x22d473030f116ddee9f6b43ac78ba3","type":"contract","entrySource":"DarkFloristMetadata","chainId":"0x5"}}}}`
		should('can extract permit2Message message', async () => {
			const parsed = EIP712Message.parse(permit2Message)
			const enrichedMessage = stringifyJSONWithBigInts(await extractEIP712Message(ethereum, undefined, parsed, false))
			assert.equal(enrichedMessage, expectedPermit2)
		})
		should('can extract permit2Message message with hex chain id', async () => {
			const parsed = EIP712Message.parse(permit2MessageHexChainId)
			const enrichedMessage = stringifyJSONWithBigInts(await extractEIP712Message(ethereum, undefined, parsed, false))
			assert.equal(enrichedMessage, expectedPermit2)
		})
		should('can extract permit2Message message with number chain id', async () => {
			const parsed = EIP712Message.parse(permit2MessageNumberChainId)
			const enrichedMessage = stringifyJSONWithBigInts(await extractEIP712Message(ethereum, undefined, parsed, false))
			assert.equal(enrichedMessage, expectedPermit2)
		})
		should('can extract openSea message', async () => {
			const parsed = EIP712Message.parse(openSeaWithTotalOriginalConsiderationItems)
			const enrichedMessage = stringifyJSONWithBigInts(await extractEIP712Message(ethereum, undefined, parsed, false))
			const expected = `{"primaryType":"OrderComponents","message":{"offerer":{"type":"address","value":{"address":"0x2f2e108d5c3d8f63a6180fbbe570b24140c71be5","name":"0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"offer":{"type":"record[]","value":[{"itemType":{"type":"unsignedInteger","value":"0x1"},"token":{"type":"address","value":{"name":"WETH","symbol":"WETH","decimals":"0x12","logoUri":"../vendor/@darkflorist/address-metadata/images/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","type":"ERC20","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x0"},"startAmount":{"type":"unsignedInteger","value":"0x16345785d8a0000"},"endAmount":{"type":"unsignedInteger","value":"0x16345785d8a0000"}}]},"consideration":{"type":"record[]","value":[{"itemType":{"type":"unsignedInteger","value":"0x2"},"token":{"type":"address","value":{"protocol":"ERC721","name":"MetaSamurai - OFFICIAL","symbol":"MS","logoUri":"../vendor/@darkflorist/address-metadata/images/nfts/0x79f1c4cf7266746698e91034d658e56913e6644f.png","address":"0x79f1c4cf7266746698e91034d658e56913e6644f","type":"ERC721","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x143"},"startAmount":{"type":"unsignedInteger","value":"0x1"},"endAmount":{"type":"unsignedInteger","value":"0x1"},"recipient":{"type":"address","value":{"address":"0x2f2e108d5c3d8f63a6180fbbe570b24140c71be5","name":"0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5","type":"contact","entrySource":"OnChain","chainId":"0x5"}}},{"itemType":{"type":"unsignedInteger","value":"0x1"},"token":{"type":"address","value":{"name":"WETH","symbol":"WETH","decimals":"0x12","logoUri":"../vendor/@darkflorist/address-metadata/images/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","type":"ERC20","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x0"},"startAmount":{"type":"unsignedInteger","value":"0x8e1bc9bf04000"},"endAmount":{"type":"unsignedInteger","value":"0x8e1bc9bf04000"},"recipient":{"type":"address","value":{"name":"OpenSea: Fees 3","protocol":"OpenSea","address":"0xa26b00c1f0df003000390027140000faa719","type":"contract","entrySource":"DarkFloristMetadata","chainId":"0x5"}}}]},"startTime":{"type":"unsignedInteger","value":"0x6458c260"},"endTime":{"type":"unsignedInteger","value":"0x645cb6dd"},"orderType":{"type":"unsignedInteger","value":"0x0"},"zone":{"type":"address","value":{"address":"0x4c00500000ad104d7dbd00e3ae0a5c00560c00","name":"0x004C00500000aD104D7DBd00e3ae0A5C00560C00","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"zoneHash":{"type":"fixedBytes","value":{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0,"16":0,"17":0,"18":0,"19":0,"20":0,"21":0,"22":0,"23":0,"24":0,"25":0,"26":0,"27":0,"28":0,"29":0,"30":0,"31":0}},"salt":{"type":"unsignedInteger","value":"0x360c6ebe000000000000000000000000000000000000000017ae0a4d2d66beb2"},"conduitKey":{"type":"fixedBytes","value":{"0":0,"1":0,"2":0,"3":123,"4":2,"5":35,"6":0,"7":145,"8":167,"9":237,"10":1,"11":35,"12":0,"13":114,"14":247,"15":0,"16":106,"17":0,"18":77,"19":96,"20":168,"21":212,"22":231,"23":29,"24":89,"25":155,"26":129,"27":4,"28":37,"29":15,"30":0,"31":0}},"counter":{"type":"unsignedInteger","value":"0x0"}},"domain":{"name":{"type":"string","value":"Seaport"},"version":{"type":"string","value":"1.5"},"chainId":{"type":"unsignedInteger","value":"0x1"},"verifyingContract":{"type":"address","value":{"address":"0xadc04c56bf30ac9d3c0aaf14dc","name":"0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC","type":"contact","entrySource":"OnChain","chainId":"0x5"}}}}`
			assert.equal(enrichedMessage, expected)
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
