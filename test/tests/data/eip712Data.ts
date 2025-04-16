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

