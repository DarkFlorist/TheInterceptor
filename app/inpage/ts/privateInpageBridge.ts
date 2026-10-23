import { INTERCEPTOR_PRIVATE_BRIDGE_EVENT } from '../../ts/utils/inpageBridgeProtocol.js'

// Capture the native event constructor while the registered MAIN script runs at document_start.
const PrivateBridgeEvent = MessageEvent
const nativeDataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get
const invokeNative = Reflect.apply

export function createPrivateInpageBridge(bridgeCapability: string, receiveMessage: (message: { readonly data: unknown }) => void) {
	if (nativeDataGetter === undefined) throw new Error('Native message data accessor is unavailable')
	const channel = new MessageChannel()
	// Never expose the native event to provider code: a page getter could recover its private currentTarget port.
	const dataGetter = nativeDataGetter
	channel.port1.onmessage = (event) => {
		const data: unknown = invokeNative(dataGetter, event, [])
		receiveMessage({ data })
	}
	const postMessage = channel.port1.postMessage.bind(channel.port1)
	const host = window.document.createElement('div')
	host.hidden = true
	host.setAttribute('data-interceptor-bridge', '')
	const root = host.attachShadow({ mode: 'closed' })
	const dispatch = root.dispatchEvent.bind(root)
	const removeHost = host.remove.bind(host)
	window.document.documentElement.appendChild(host)
	// WebIDL converts ports through the iterable protocol. Keep every iterator operation private and own so later page changes to Array/Iterator prototypes cannot see port2.
	const privatePort = channel.port2
	const ports = [privatePort]
	Object.defineProperty(ports, Symbol.iterator, { value: () => {
		let pending = true
		return { next: () => {
			if (!pending) return { done: true, value: undefined }
			pending = false
			return { done: false, value: privatePort }
		} }
	} })
	const eventOptions: MessageEventInit<string> = { cancelable: true, data: '', ports }
	// Dictionary conversion must not consult getters a page adds to Object.prototype.
	Object.setPrototypeOf(eventOptions, null)
	let initializedSecret: string | undefined
	return {
		postMessage,
		offerPort(bootstrapSecret: string) {
			if (initializedSecret !== undefined) return initializedSecret === bootstrapSecret
			// The secret is compared by the isolated receiver. A page calling this entry point cannot see the non-composed event inside the closed root or guess the receiver's nonce.
			eventOptions.data = `${ bootstrapSecret }:${ bridgeCapability }`
			const accepted = !dispatch(new PrivateBridgeEvent(INTERCEPTOR_PRIVATE_BRIDGE_EVENT, eventOptions))
			if (!accepted) return false
			initializedSecret = bootstrapSecret
			removeHost()
			return true
		},
	}
}
