import * as assert from 'node:assert'
import { test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getNetworkWithoutRpcWarningState } from '../../app/ts/utils/networkWithoutRpcUi.js'
import { SigningWalletBindings } from '../../app/ts/types/signingWallet.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'

const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
const activeAddress = BigInt(privateKeyToAccount(privateKey).address)
const ledgerBinding = { revision: crypto.randomUUID(), wallet: { type: 'ledger' as const, label: 'Ledger', address: activeAddress, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), false)), derivationPath: 'm/44\'/60\'/0\'/0/0' } }
const storedItems: Record<string, unknown> = {}
Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: { storage: { local: { get: async () => ({ ...storedItems }) } } } })
const { resolveSigningRequest } = await import('../../app/ts/background/signingRequestResolver.js')

const socket = { tabId: 1, connectionName: 0n }
const rpcNetwork = { name: 'Signer only', chainId: 1n, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }

// The network-without-RPC warning describes what forwarding does, so for every state a forwarded request means the warning says the Interceptor is bypassed, and an intercepted one means it is not.
test('the network-without-RPC warning agrees with request forwarding in every routing state', async () => {
	for (const hasRpc of [false, true]) for (const simulationMode of [false, true]) for (const signerAvailability of ['available', 'missing'] as const) for (const activeAddressSignsDirectly of [false, true]) {
		storedItems.signingWalletBindings = SigningWalletBindings.serialize(activeAddressSignsDirectly ? [ledgerBinding] : [])
		const network = hasRpc ? { ...rpcNetwork, httpsRpc: 'https://rpc.example.test' } : rpcNetwork
		const rawRequest = { method: 'eth_blockNumber', params: [], interceptorRequest: true as const, usingInterceptorWithoutSigner: signerAvailability === 'missing', uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }
		const settings = { simulationMode, activeRpcNetwork: network, selectedSigningAddress: undefined }
		const { forwardingReply } = await resolveSigningRequest(new Map(), socket, rawRequest, EthereumJsonRpcRequest.parse({ method: 'eth_blockNumber', params: [] }), settings, activeAddress, undefined, false, simulationMode, undefined)
		const warning = getNetworkWithoutRpcWarningState(network, simulationMode, signerAvailability, activeAddressSignsDirectly)
		const state = JSON.stringify({ hasRpc, simulationMode, signerAvailability, activeAddressSignsDirectly })
		assert.equal(forwardingReply !== undefined, warning.kind === 'noRpcBypassToSigner', state)
		if (hasRpc) assert.equal(warning.kind, 'none', state)
	}
})
