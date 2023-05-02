import { EIP712Message } from '../../app/ts/utils/wire-types.js'
import { Permit2 } from '../../app/ts/utils/personal-message-definitions.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'

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
	describe('EIP712', () => {
		should('can parse EIP712 message', () => {
			EIP712Message.parse(permit2Message)
		})
		should('can parse Permit2 message', () => {
			Permit2.parse(JSON.parse(permit2Message))
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
