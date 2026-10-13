// Helpers for inspecting the untyped messages that tests record from browser.runtime.sendMessage (for example browserMock.calls.runtimeSendMessage).

export function getMessageMethod(message: unknown) {
	if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
	return typeof message.method === 'string' ? message.method : undefined
}

export const hasMessageMethod = (message: unknown, method: string) => getMessageMethod(message) === method

export const getMessageMethods = (messages: readonly unknown[]) => messages.flatMap((message) => getMessageMethod(message) ?? [])

export function getMessageWithMethod(messages: readonly unknown[], method: string) {
	const message = messages.find((candidate) => hasMessageMethod(candidate, method))
	if (message === undefined) throw new Error(`Expected a message with method "${ method }"`)
	return message
}
