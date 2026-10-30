// Content scripts can message the background too; only extension pages may start or cancel a workflow that injects a script into a tab and reloads it.
export function canHandleSafeAppPreparationMessage(message: unknown, sender: browser.runtime.MessageSender, extensionId: string, extensionRootUrl: string): boolean {
	if (typeof message !== 'object' || message === null || !('method' in message)) return true
	if (message.method !== 'popup_prepareSafeApp' && message.method !== 'popup_cancelPrepareSafeApp') return true
	return sender.id === extensionId && typeof sender.url === 'string' && sender.url.startsWith(extensionRootUrl)
}
