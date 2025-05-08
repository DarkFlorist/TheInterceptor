import { Permit2, SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import { extractEIP712Message, validateEIP712Types } from '../../app/ts/utils/eip712Parsing.js'
import * as assert from 'assert'
import { stringifyJSONWithBigInts } from '../../app/ts/utils/bigint.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { getMessageAndDomainHash, verifyEip712Message } from '../../app/ts/utils/eip712.js'
import { canVerifyStructArray, chainIdIsNotDefined, chainIdOverFlow, d2Array, d2ArrayFixed, d3ArrayFixed, duplicateType, eip712Example, eip721DomainMissing, extraType, fixedArrayOverload, hasArray, hasFixedArray, hasTooLongFixedArray, missingChainId, openSeaWithTotalOriginalConsiderationItems, permit2Message, permit2MessageHexChainId, permit2MessageNumberChainId, primarytypeIsWrong, safeTx, smallOverFlow, structNotDefined, tupleSupport, typeMissmatch, unknownExtraField, unknownExtraField2 } from './data/eip712Data.js'

export async function main() {

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
		should('can verify a permit 2 message EIP712 message', () => {
			const verification = verifyEip712Message(JSON.parse(permit2Message))
			if (verification.valid === false) throw new Error(verification.reason)
			getMessageAndDomainHash({method: 'eth_signTypedData_v4', params: [0x1n, JSON.parse(permit2Message)]})
		})
		should('can verify a safe EIP712 message', () => {
			const verification = verifyEip712Message(JSON.parse(safeTx))
			if (verification.valid === false) throw new Error(verification.reason)
				getMessageAndDomainHash({method: 'eth_signTypedData_v4', params: [0x1n, JSON.parse(safeTx)]})
		})
		should('can verify an opensea message', () => {
			const verification = verifyEip712Message(JSON.parse(openSeaWithTotalOriginalConsiderationItems))
			if (verification.valid === false) throw new Error(verification.reason)
				getMessageAndDomainHash({method: 'eth_signTypedData_v4', params: [0x1n, JSON.parse(openSeaWithTotalOriginalConsiderationItems)]})
		})
		should('can verify permit2MessageHexChainId message', () => {
			const verification = verifyEip712Message(JSON.parse(permit2MessageHexChainId))
			if (verification.valid === false) throw new Error(verification.reason)
				getMessageAndDomainHash({method: 'eth_signTypedData_v4', params: [0x1n, JSON.parse(permit2MessageHexChainId)]})
		})
		should('can verify eip712Example message', () => {
			const verification = verifyEip712Message(JSON.parse(eip712Example))
			if (verification.valid === false) throw new Error(verification.reason)
				getMessageAndDomainHash({method: 'eth_signTypedData_v4', params: [0x1n, JSON.parse(eip712Example)]})
		})
		should('can verify permit2MessageNumberChainId message', () => {
			const verification = verifyEip712Message(JSON.parse(permit2MessageNumberChainId))
			if (verification.valid === false) throw new Error(verification.reason)
		})
		should('can not verify chainIdIsNotDefined message', () => {
			const verification = verifyEip712Message(JSON.parse(chainIdIsNotDefined))
			assert.deepEqual(verification, { valid: false, reason: 'EIP712Domain was invalid: Failed to find type for chainId' })
		})
		should('can not verify primarytypeIsWrong message', () => {
			const verification = verifyEip712Message(JSON.parse(primarytypeIsWrong))
			assert.equal(verification.valid, false)
		})
		should('can not verify eip721DomainMissing message', () => {
			const verification = verifyEip712Message(JSON.parse(eip721DomainMissing))
			assert.equal(verification.valid, false)
		})
		should('can not verify structNotDefined message', () => {
			const verification = verifyEip712Message(JSON.parse(structNotDefined))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: unknown type: Person2' })
		})
		should('can verify extraType message', () => {
			const verification = verifyEip712Message(JSON.parse(extraType))
			assert.equal(verification.valid, true)
		})
		should('can verify missingChainId message', () => {
			const verification = verifyEip712Message(JSON.parse(missingChainId))
			assert.equal(verification.valid, true)
		})
		should('can verify hasArray message', () => {
			const verification = verifyEip712Message(JSON.parse(hasArray))
			assert.equal(verification.valid, true)
		})
		should('can verify hasFixedArray message', () => {
			const verification = verifyEip712Message(JSON.parse(hasFixedArray))
			assert.equal(verification.valid, true)
		})
		should('can verify canVerifyStructArray message', () => {
			const verification = verifyEip712Message(JSON.parse(canVerifyStructArray))
			assert.equal(verification.valid, true)
		})
		should('can not verify chainIdOverFlow message', () => {
			const verification = verifyEip712Message(JSON.parse(chainIdOverFlow))
			assert.deepEqual(verification, { valid: false, reason: 'EIP712Domain.chainId is in wrong type' })
		})
		should('can not verify hasTooLongFixedArray message', () => {
			const verification = verifyEip712Message(JSON.parse(hasTooLongFixedArray))
			assert.equal(verification.valid, true)
		})
		should('can not verify fixedArrayOverload message', () => {
			const verification = verifyEip712Message(JSON.parse(fixedArrayOverload))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: contents: ["Hello, Bob!","hellow cow!"] is invalid: expected array of length 1, got 2' })
		})
		should('can not verify duplicateType message', () => {
			const verification = verifyEip712Message(JSON.parse(duplicateType))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: not unique type names' })
		})
		should('can not verify unknownExtraField message', () => {
			const verification = verifyEip712Message(JSON.parse(unknownExtraField))
			assert.deepEqual(verification, { valid: false, reason: 'EIP712 message should only have 4 fields' })
		})
		should('can not verify unknownExtraField2 message', () => {
			const verification = verifyEip712Message(JSON.parse(unknownExtraField2))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: Failed to find type for test' })
		})
		should('can not verify typeMissmatch message', () => {
			const verification = verifyEip712Message(JSON.parse(typeMissmatch))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: from: {"name":"Cow","wallet":5} is invalid 5 is not address' })
		})
		should('can not verify smallOverFlow message', () => {
			const verification = verifyEip712Message(JSON.parse(smallOverFlow))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: overflow: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" is invalid: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" is out of bounds of uint8' })
		})
		should('can not verify message with tuples (not supported by eip712)', () => {
			const verification = verifyEip712Message(JSON.parse(tupleSupport))
			assert.deepEqual(verification, { valid: false, reason: 'Message was invalid: unknown type: tuple(uint256, uint256)'})
		})
		should('can verify d2Array message', () => {
			const parsed = EIP712Message.parse(d2Array)
			assert.deepEqual(verifyEip712Message(parsed), { valid: true })
		})
		should('can verify d2ArrayFixed message', () => {
			const parsed = EIP712Message.parse(d2ArrayFixed)
			assert.deepEqual(verifyEip712Message(parsed), { valid: true })
		})
		should('can verify d3ArrayFixed message', () => {
			const parsed = EIP712Message.parse(d3ArrayFixed)
			assert.deepEqual(verifyEip712Message(parsed), { valid: true })
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
			const expected = `{"primaryType":"SafeTx","message":{"to":{"type":"address","value":{"address":"0xa01fcd80503365406042456c7be1dd7e35b38f9c","name":"0xA01FCd80503365406042456C7be1DD7E35B38f9c","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"value":{"type":"unsignedInteger","value":"0x4563918244f40000"},"data":{"type":"bytes","value":"0x"},"operation":{"type":"unsignedInteger","value":"0x0"},"safeTxGas":{"type":"unsignedInteger","value":"0x0"},"baseGas":{"type":"unsignedInteger","value":"0x0"},"gasPrice":{"type":"unsignedInteger","value":"0x0"},"gasToken":{"type":"address","value":{"address":"0x0","name":"0x0 Address","type":"contact","entrySource":"Interceptor","chainId":"0x5"}},"refundReceiver":{"type":"address","value":{"address":"0x0","name":"0x0 Address","type":"contact","entrySource":"Interceptor","chainId":"0x5"}},"nonce":{"type":"unsignedInteger","value":"0x10"}},"domain":{"chainId":{"type":"unsignedInteger","value":"0x1"},"verifyingContract":{"type":"address","value":{"address":"0x8e160c8e949967d6b797cdf2a2f38f6344a5c95f","name":"0x8e160C8E949967D6B797CdF2A2F38f6344a5C95f","type":"contact","entrySource":"OnChain","chainId":"0x5"}}}}`
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
			const expected = `{"primaryType":"OrderComponents","message":{"offerer":{"type":"address","value":{"address":"0x2f2e108d5c3d8f63a6180fbbe570b24140c71be5","name":"0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"offer":{"type":"record[]","value":[{"itemType":{"type":"unsignedInteger","value":"0x1"},"token":{"type":"address","value":{"name":"WETH","symbol":"WETH","decimals":"0x12","logoUri":"../vendor/@darkflorist/address-metadata/images/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","type":"ERC20","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x0"},"startAmount":{"type":"unsignedInteger","value":"0x16345785d8a0000"},"endAmount":{"type":"unsignedInteger","value":"0x16345785d8a0000"}}]},"consideration":{"type":"record[]","value":[{"itemType":{"type":"unsignedInteger","value":"0x2"},"token":{"type":"address","value":{"protocol":"ERC721","name":"MetaSamurai - OFFICIAL","symbol":"MS","logoUri":"../vendor/@darkflorist/address-metadata/images/nfts/0x79f1c4cf7266746698e91034d658e56913e6644f.png","address":"0x79f1c4cf7266746698e91034d658e56913e6644f","type":"ERC721","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x143"},"startAmount":{"type":"unsignedInteger","value":"0x1"},"endAmount":{"type":"unsignedInteger","value":"0x1"},"recipient":{"type":"address","value":{"address":"0x2f2e108d5c3d8f63a6180fbbe570b24140c71be5","name":"0x2F2e108d5c3d8F63A6180FBBe570B24140c71bE5","type":"contact","entrySource":"OnChain","chainId":"0x5"}}},{"itemType":{"type":"unsignedInteger","value":"0x1"},"token":{"type":"address","value":{"name":"WETH","symbol":"WETH","decimals":"0x12","logoUri":"../vendor/@darkflorist/address-metadata/images/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png","address":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","type":"ERC20","entrySource":"DarkFloristMetadata","chainId":"0x5"}},"identifierOrCriteria":{"type":"unsignedInteger","value":"0x0"},"startAmount":{"type":"unsignedInteger","value":"0x8e1bc9bf04000"},"endAmount":{"type":"unsignedInteger","value":"0x8e1bc9bf04000"},"recipient":{"type":"address","value":{"name":"OpenSea: Fees 3","protocol":"OpenSea","address":"0xa26b00c1f0df003000390027140000faa719","type":"contract","entrySource":"DarkFloristMetadata","chainId":"0x5"}}}]},"startTime":{"type":"unsignedInteger","value":"0x6458c260"},"endTime":{"type":"unsignedInteger","value":"0x645cb6dd"},"orderType":{"type":"unsignedInteger","value":"0x0"},"zone":{"type":"address","value":{"address":"0x4c00500000ad104d7dbd00e3ae0a5c00560c00","name":"0x004C00500000aD104D7DBd00e3ae0A5C00560C00","type":"contact","entrySource":"OnChain","chainId":"0x5"}},"zoneHash":{"type":"fixedBytes","value":"0x0000000000000000000000000000000000000000000000000000000000000000"},"salt":{"type":"unsignedInteger","value":"0x360c6ebe000000000000000000000000000000000000000017ae0a4d2d66beb2"},"conduitKey":{"type":"fixedBytes","value":"0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000"},"counter":{"type":"unsignedInteger","value":"0x0"}},"domain":{"name":{"type":"string","value":"Seaport"},"version":{"type":"string","value":"1.5"},"chainId":{"type":"unsignedInteger","value":"0x1"},"verifyingContract":{"type":"address","value":{"address":"0xadc04c56bf30ac9d3c0aaf14dc","name":"0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC","type":"contact","entrySource":"OnChain","chainId":"0x5"}}}}`
			assert.equal(enrichedMessage, expected)
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
