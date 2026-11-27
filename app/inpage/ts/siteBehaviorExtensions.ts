import { installRpcReadInterception } from './rpcReadInterception.js'

// Site-neutral extension point: capabilities arrive over their own context channel. Hosted pages capture fetch before SDK clients retain it; ordinary pages instantiate only when provisioned. Retained references still need live context before any overlay.
export function createSiteBehaviorExtensions(windowObject: Parameters<typeof installRpcReadInterception>[0], requestRpc: Parameters<typeof installRpcReadInterception>[1], captureBeforeContext = false) {
	let rpcReads = captureBeforeContext ? installRpcReadInterception(windowObject, requestRpc, true) : undefined
	const dispose = () => { rpcReads?.dispose(); rpcReads = undefined }
	return {
		setContext(value: unknown) {
			const context = typeof value === 'object' && value !== null && 'rpcInterception' in value ? value.rpcInterception : undefined
			if (context === undefined) { rpcReads?.setContext(undefined); return }
			const firstPublication = rpcReads === undefined
			rpcReads ??= installRpcReadInterception(windowObject, requestRpc)
			// Retractions deactivate the same hook so retained page wrappers can resume it; only a rejected first publication or final teardown discards it.
			if (!rpcReads.setContext(context) && firstPublication) dispose()
		},
		dispose,
	}
}
