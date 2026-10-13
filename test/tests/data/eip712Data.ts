export const permit2Message = `{
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

export const permit2MessageHexChainId = `{
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

export const permit2MessageNumberChainId = `{
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

export const safeTx = `{
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

export const openSeaWithTotalOriginalConsiderationItems = `{
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

export const eip712Example = `{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}`

export const chainIdIsNotDefined = `{
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
				"name": "verifyingContract",
				"type": "address"
			}
		],
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const primarytypeIsWrong = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail2",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}
`

export const eip721DomainMissing = `{
	"types": {
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const structNotDefined = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person2"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const extraType = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Person2": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const chainIdOverFlow = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`


export const missingChainId = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const hasArray = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": ["Hello, Bob!"]
	}
}
`

export const hasFixedArray = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[1]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": ["Hello, Bob!"]
	}
}
`

export const hasTooLongFixedArray = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[2]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": ["Hello, Bob!"]
	}
}
`

export const fixedArrayOverload = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[1]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": ["Hello, Bob!", "hellow cow!"]
	}
}
`
export const canVerifyStructArray = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person[]"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": [{
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		}],
		"contents": "Hello, Bob!"
	}
}
`

export const duplicateType = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const unknownExtraField = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"unknownExtra": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}
`

export const unknownExtraField2 = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"test": "no type",
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}
`

export const typeMissmatch = `
{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": 5
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}
`

export const smallOverFlow = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			},
			{
				"name": "overflow",
				"type": "uint8"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"overflow": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const tupleSupport = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string"
			},
			{
				"name": "tuplesupport",
				"type": "tuple(uint256, uint256)"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"tuplesupport": [10,20],
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": "Hello, Bob!"
	}
}`

export const d2Array = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[][]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": [["Hello, Bob!"],["Hello"]]
	}
}`

export const d2ArrayFixed = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[2][2]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": [["Hello, Bob!"],["Hello"]]
	}
}`
export const d3ArrayFixed = `{
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
		"Person": [
			{
				"name": "name",
				"type": "string"
			},
			{
				"name": "wallet",
				"type": "address"
			}
		],
		"Mail": [
			{
				"name": "from",
				"type": "Person"
			},
			{
				"name": "to",
				"type": "Person"
			},
			{
				"name": "contents",
				"type": "string[1][1][1]"
			}
		]
	},
	"primaryType": "Mail",
	"domain": {
		"name": "Ether Mail",
		"version": "1",
		"chainId": 1,
		"verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
	},
	"message": {
		"from": {
			"name": "Cow",
			"wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
		},
		"to": {
			"name": "Bob",
			"wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
		},
		"contents": [[["Hello, Bob!"]]]
	}
}`


const permit2Domain = { name: 'Permit2', chainId: '1', verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' }
const permit2DomainTypes = [
	{ name: 'name', type: 'string' },
	{ name: 'chainId', type: 'uint256' },
	{ name: 'verifyingContract', type: 'address' },
]
const permit2DetailsTypes = [
	{ name: 'token', type: 'address' },
	{ name: 'amount', type: 'uint160' },
	{ name: 'expiration', type: 'uint48' },
	{ name: 'nonce', type: 'uint48' },
]
const permit2TokenPermissionsTypes = [
	{ name: 'token', type: 'address' },
	{ name: 'amount', type: 'uint256' },
]
const permit2SignatureTransferTypes = (permittedType: string, witnessType?: { name: string, type: string }) => [
	{ name: 'permitted', type: permittedType },
	{ name: 'spender', type: 'address' },
	{ name: 'nonce', type: 'uint256' },
	{ name: 'deadline', type: 'uint256' },
	...(witnessType === undefined ? [] : [witnessType]),
]

export const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const usdtAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
export const uniswapUniversalRouter = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
export const maxUint256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
export const permit2Signer = '0x7a16ff8270133f063aab6c9977183d9e72835428'
export const uniswapXExclusiveDutchOrderReactor = '0x6000da47483062a0d734ba3dc7576ce6a0b645c4'

export const permit2PermitBatchMessage = JSON.stringify({
	types: {
		PermitBatch: [
			{ name: 'details', type: 'PermitDetails[]' },
			{ name: 'spender', type: 'address' },
			{ name: 'sigDeadline', type: 'uint256' },
		],
		PermitDetails: permit2DetailsTypes,
		EIP712Domain: permit2DomainTypes,
	},
	domain: permit2Domain,
	primaryType: 'PermitBatch',
	message: {
		details: [
			{ token: usdcAddress, amount: '1461501637330902918203684832716283019655932542975', expiration: '281474976710655', nonce: '0' },
			{ token: usdtAddress, amount: '5000000', expiration: '1700000000', nonce: '3' },
		],
		spender: uniswapUniversalRouter,
		sigDeadline: '1700000000',
	},
})

export const permit2TransferFromMessage = JSON.stringify({
	types: {
		PermitTransferFrom: permit2SignatureTransferTypes('TokenPermissions'),
		TokenPermissions: permit2TokenPermissionsTypes,
		EIP712Domain: permit2DomainTypes,
	},
	domain: permit2Domain,
	primaryType: 'PermitTransferFrom',
	message: {
		permitted: { token: usdtAddress, amount: '1000000' },
		spender: uniswapUniversalRouter,
		nonce: '7',
		deadline: '1700000000',
	},
})

export const permit2BatchTransferFromMessage = JSON.stringify({
	types: {
		PermitBatchTransferFrom: permit2SignatureTransferTypes('TokenPermissions[]'),
		TokenPermissions: permit2TokenPermissionsTypes,
		EIP712Domain: permit2DomainTypes,
	},
	domain: permit2Domain,
	primaryType: 'PermitBatchTransferFrom',
	message: {
		permitted: [
			{ token: usdcAddress, amount: maxUint256 },
			{ token: wethAddress, amount: '2500000000000000000' },
		],
		spender: '0x5555555555555555555555555555555555555555',
		nonce: '0',
		deadline: maxUint256,
	},
})

const uniswapXOrderNonce = '1993353164669688581970088190602701610528397285201889446578254799128576197633'

// Shaped like the UniswapX ExclusiveDutchOrder that app.uniswap.org asks to be signed when swapping 1000 USDC to ether.
export const permit2UniswapXWitnessTransferFromMessage = JSON.stringify({
	types: {
		EIP712Domain: permit2DomainTypes,
		PermitWitnessTransferFrom: permit2SignatureTransferTypes('TokenPermissions', { name: 'witness', type: 'ExclusiveDutchOrder' }),
		TokenPermissions: permit2TokenPermissionsTypes,
		ExclusiveDutchOrder: [
			{ name: 'info', type: 'OrderInfo' },
			{ name: 'decayStartTime', type: 'uint256' },
			{ name: 'decayEndTime', type: 'uint256' },
			{ name: 'exclusiveFiller', type: 'address' },
			{ name: 'exclusivityOverrideBps', type: 'uint256' },
			{ name: 'inputToken', type: 'address' },
			{ name: 'inputStartAmount', type: 'uint256' },
			{ name: 'inputEndAmount', type: 'uint256' },
			{ name: 'outputs', type: 'DutchOutput[]' },
		],
		OrderInfo: [
			{ name: 'reactor', type: 'address' },
			{ name: 'swapper', type: 'address' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'additionalValidationContract', type: 'address' },
			{ name: 'additionalValidationData', type: 'bytes' },
		],
		DutchOutput: [
			{ name: 'token', type: 'address' },
			{ name: 'startAmount', type: 'uint256' },
			{ name: 'endAmount', type: 'uint256' },
			{ name: 'recipient', type: 'address' },
		],
	},
	domain: permit2Domain,
	primaryType: 'PermitWitnessTransferFrom',
	message: {
		permitted: { token: usdcAddress, amount: '1000000000' },
		spender: uniswapXExclusiveDutchOrderReactor,
		nonce: uniswapXOrderNonce,
		deadline: '1700000060',
		witness: {
			info: {
				reactor: uniswapXExclusiveDutchOrderReactor,
				swapper: permit2Signer,
				nonce: uniswapXOrderNonce,
				deadline: '1700000060',
				additionalValidationContract: '0x0000000000000000000000000000000000000000',
				additionalValidationData: '0x',
			},
			decayStartTime: '1700000000',
			decayEndTime: '1700000060',
			exclusiveFiller: '0xff8ba4d1fc3762f6154cc942ccf30049a2a0cec6',
			exclusivityOverrideBps: '100',
			inputToken: usdcAddress,
			inputStartAmount: '1000000000',
			inputEndAmount: '1000000000',
			outputs: [
				{ token: '0x0000000000000000000000000000000000000000', startAmount: '495000000000000000', endAmount: '490000000000000000', recipient: permit2Signer },
				{ token: '0x0000000000000000000000000000000000000000', startAmount: '1240000000000000', endAmount: '1228000000000000', recipient: '0x000000fee13a103a10d593b9ae06b3e05f2e7e1c' },
			],
		},
	},
})

// The witness field name is integrator defined too, this one follows the 0x Settler `SlippageAndActions slippageAndActions` witness.
export const permit2BatchWitnessTransferFromMessage = JSON.stringify({
	types: {
		EIP712Domain: permit2DomainTypes,
		PermitBatchWitnessTransferFrom: permit2SignatureTransferTypes('TokenPermissions[]', { name: 'slippageAndActions', type: 'SlippageAndActions' }),
		SlippageAndActions: [
			{ name: 'recipient', type: 'address' },
			{ name: 'buyToken', type: 'address' },
			{ name: 'minAmountOut', type: 'uint256' },
			{ name: 'actions', type: 'bytes[]' },
		],
		TokenPermissions: permit2TokenPermissionsTypes,
	},
	domain: permit2Domain,
	primaryType: 'PermitBatchWitnessTransferFrom',
	message: {
		permitted: [
			{ token: usdcAddress, amount: '1000000000' },
			{ token: usdtAddress, amount: '2000000' },
		],
		spender: '0x5555555555555555555555555555555555555555',
		nonce: '11',
		deadline: '1700000000',
		slippageAndActions: {
			recipient: permit2Signer,
			buyToken: wethAddress,
			minAmountOut: '400000000000000000',
			actions: ['0xdeadbeef'],
		},
	},
})

// A valid EIP-712 message that is not a Permit2 witness transfer, as Permit2 requires the witness to be the last field.
export const permit2WitnessTransferFromWitnessNotLastMessage = JSON.stringify({
	types: {
		EIP712Domain: permit2DomainTypes,
		PermitWitnessTransferFrom: [
			{ name: 'permitted', type: 'TokenPermissions' },
			{ name: 'spender', type: 'address' },
			{ name: 'witness', type: 'MockWitness' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
		],
		MockWitness: [{ name: 'value', type: 'uint256' }],
		TokenPermissions: permit2TokenPermissionsTypes,
	},
	domain: permit2Domain,
	primaryType: 'PermitWitnessTransferFrom',
	message: {
		permitted: { token: usdcAddress, amount: '1000000000' },
		spender: '0x5555555555555555555555555555555555555555',
		witness: { value: '1' },
		nonce: '0',
		deadline: '1700000000',
	},
})

const eip2612DomainTypes = [
	{ name: 'name', type: 'string' },
	{ name: 'version', type: 'string' },
	{ name: 'chainId', type: 'uint256' },
	{ name: 'verifyingContract', type: 'address' },
]

// Shaped like the USDC permit that dapps send through viem or ethers, which encode the chain ID as a JSON number and the uint256 message fields as decimal strings.
export const eip2612UsdcPermitMessage = JSON.stringify({
	types: {
		EIP712Domain: eip2612DomainTypes,
		Permit: [
			{ name: 'owner', type: 'address' },
			{ name: 'spender', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
		],
	},
	primaryType: 'Permit',
	domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: usdcAddress },
	message: {
		owner: permit2Signer,
		spender: uniswapUniversalRouter,
		value: '1000000000',
		nonce: '3',
		deadline: '1700000000',
	},
})

// Dai's permit predates EIP-2612 and signs a different `Permit` struct, so it has to be shown as a generic EIP-712 message.
export const daiPermitMessage = JSON.stringify({
	types: {
		EIP712Domain: eip2612DomainTypes,
		Permit: [
			{ name: 'holder', type: 'address' },
			{ name: 'spender', type: 'address' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'expiry', type: 'uint256' },
			{ name: 'allowed', type: 'bool' },
		],
	},
	primaryType: 'Permit',
	domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: '0x6b175474e89094c44da98b954eedeac495271d0f' },
	message: {
		holder: permit2Signer,
		spender: uniswapUniversalRouter,
		nonce: 0,
		expiry: 1700000000,
		allowed: true,
	},
})
