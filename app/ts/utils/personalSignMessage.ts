import { bytesFromHex, isHexString, stringToBytes } from './ethereumBytes.js'

const HEX_DIGITS_REGEX = /^[0-9a-fA-F]+$/u

const hexDigitsToLeftPaddedBytes = (hexDigits: string) => bytesFromHex(`0x${ hexDigits.length % 2 === 0 ? hexDigits : `0${ hexDigits }` }`)

// Mirrors MetaMask personal_sign: SignatureController normalizePersonalMessageData reads an optional 0x or 0X prefix followed by at least one hex digit as bytes and anything else, including a bare 0x, as UTF-8 text, then the keyring's legacyToBuffer left-pads odd-length hex to whole bytes.
export const getPersonalSignMessageBytes = (message: string) => {
	const withoutHexPrefix = /^0x/iu.test(message) ? message.slice(2) : message
	return HEX_DIGITS_REGEX.test(withoutHexPrefix) ? hexDigitsToLeftPaddedBytes(withoutHexPrefix) : stringToBytes(message)
}

// Mirrors MetaMask personal_ecRecover: eth-json-rpc-middleware passes the message straight to eth-sig-util recoverPersonalSignature, whose legacyToBuffer reads a 0x-prefixed hex string as bytes, left-padded to whole bytes, and any other string as UTF-8 text.
export const getPersonalEcRecoverMessageBytes = (message: string) => isHexString(message) ? hexDigitsToLeftPaddedBytes(message.slice(2)) : stringToBytes(message)

// The bytes personal_sign signs, as UTF-8 text with replacement characters for bytes that are not valid UTF-8.
export const decodePersonalSignMessage = (message: string) => new TextDecoder().decode(getPersonalSignMessageBytes(message))
