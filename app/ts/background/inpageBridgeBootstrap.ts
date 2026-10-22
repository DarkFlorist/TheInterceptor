import { invokeInpageBridgeInitializer } from '../utils/inpageBridgeProtocol.js'

export async function initializeInpageBridge(message: unknown, sender: browser.runtime.MessageSender) {
	if (typeof message !== 'object' || message === null || !('method' in message) || message.method !== 'initialize_inpage_bridge') return undefined
	if (sender.id !== browser.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined) throw new Error('Invalid inpage bootstrap sender')
	if (!('bridgeSecret' in message) || typeof message.bridgeSecret !== 'string' || !/^[0-9a-f]{64}$/u.test(message.bridgeSecret)) throw new Error('Invalid inpage bootstrap key')
	// A document target prevents a delayed bootstrap from passing the previous document's key to a replacement page.
	if (!('documentId' in sender) || typeof sender.documentId !== 'string') throw new Error('Inpage bootstrap requires a document target')
	const injection = {
		target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
		world: 'MAIN',
		func: invokeInpageBridgeInitializer,
		args: [message.bridgeSecret],
	}
	const results: unknown = await Reflect.apply(browser.scripting.executeScript, browser.scripting, [injection])
	if (!Array.isArray(results)) throw new Error('Invalid inpage bootstrap result')
	return results.some((entry: unknown) => typeof entry === 'object' && entry !== null && 'result' in entry && entry.result === true)
}
