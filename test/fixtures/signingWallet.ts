// Local wallet double: returned transaction hashes never represent a real broadcast.
export function createSigningWalletScript(address: string, transactionHash: string) {
return `(() => {
	globalThis.__fakeSignerPreloadStarted = true
	const requests = []
	const aggregateRequests = []
	const listeners = new Map()
	const signer = {
		isMetaMask: true,
		selectedAddress: ${ JSON.stringify(address) },
		isConnected: () => true,
		request: async ({ method }) => {
			requests.push(method)
			switch (method) {
				case 'eth_chainId': return '0x1'
				case 'eth_accounts':
				case 'eth_requestAccounts': return [${ JSON.stringify(address) }]
				case 'eth_sendTransaction': return ${ JSON.stringify(transactionHash) }
				default: throw Object.assign(new Error('Unsupported fake signer method: ' + method), { code: -32601 })
			}
		},
		on: (event, callback) => {
			listeners.set(event, [...listeners.get(event) ?? [], callback])
			return signer
		},
		removeListener: (event, callback) => {
			listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== callback))
			return signer
		},
	}
	globalThis.__fakeSignerRequests = requests
	globalThis.__aggregateSignerRequests = aggregateRequests
	globalThis.ethereum = {
		isBraveWallet: true,
		isConnected: () => true,
		request: async ({ method }) => {
			aggregateRequests.push(method)
			if (method === 'eth_chainId') return '0x1'
			if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [${ JSON.stringify(address) }]
			return await new Promise(() => undefined)
		},
		on: () => globalThis.ethereum,
		removeListener: () => globalThis.ethereum,
	}
	globalThis.addEventListener('eip6963:requestProvider', () => globalThis.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
		detail: {
			info: { uuid: '44444444-4444-4444-8444-444444444444', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
			provider: signer,
		},
	})))
})()`
}
