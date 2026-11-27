import { isPopupMessageMethod, requiresExtensionPageSender } from '../types/popupMessageProtocol.js'

export type PopupMessageSenderKind = 'extension-page' | 'other'

// Content scripts run under this extension's id too, so only a sender on this extension's own origin counts as an extension page.
export function getPopupMessageSenderKind(sender: browser.runtime.MessageSender, extensionId: string, extensionRootUrl: string): PopupMessageSenderKind {
	return sender.id === extensionId && typeof sender.url === 'string' && sender.url.startsWith(extensionRootUrl) ? 'extension-page' : 'other'
}

// The sender requirement is declared per method in popupMessageProtocol; this check only reads that metadata. Messages without a known popup method are left to the parser, which rejects them.
export function isPopupMessageAllowedFromSender(message: unknown, senderKind: PopupMessageSenderKind): boolean {
	if (senderKind === 'extension-page') return true
	if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') return true
	if (!isPopupMessageMethod(message.method)) return true
	return !requiresExtensionPageSender(message.method)
}
