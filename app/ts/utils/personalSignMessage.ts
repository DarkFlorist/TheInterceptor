import { EthereumData } from '../types/wire-types.js'

// personal_sign messages arrive either as 0x-prefixed bytes or as plain text. Bytes are decoded as UTF-8; anything else is already the text.
export const decodePersonalSignMessage = (message: string) => {
	if (!message.startsWith('0x')) return message
	const parsedMessage = EthereumData.safeParse(message)
	if (parsedMessage.success) return new TextDecoder().decode(parsedMessage.value)
	return message
}
