import { generateBridgeSecret } from '../../ts/utils/bridgeBootstrapSecret.js'

const contentScriptListener = Reflect.get(globalThis, Symbol.for('TheInterceptor.listenContentScript'))
if (typeof contentScriptListener !== 'function') throw new Error('Interceptor content script listener was not initialized')
const bridgeSecret = generateBridgeSecret()
const prepareBridge: unknown = contentScriptListener(undefined, 'content-script', bridgeSecret)
if (typeof prepareBridge !== 'function') throw new Error('Missing private bridge preparation callback')

// The key crosses realms only as a privileged executeScript argument, never as a page message or DOM attribute.
async function initializeMainWorldBridge(attempt = 0) {
	if (typeof prepareBridge !== 'function') throw new Error('Missing private bridge preparation callback')
	prepareBridge()
	const initialized = await browser.runtime.sendMessage({ method: 'initialize_inpage_bridge', bridgeSecret })
	if (initialized === true) return
	if (attempt >= 20) throw new Error('The inpage bridge could not be initialized for this document')
	setTimeout(() => { void initializeMainWorldBridge(attempt + 1) }, 250)
}
void initializeMainWorldBridge()
