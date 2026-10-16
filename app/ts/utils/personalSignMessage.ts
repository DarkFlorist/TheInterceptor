import { bytesFromHex, isHexString, stringToBytes } from './ethereumBytes.js'

const HEX_DIGITS_REGEX = /^[0-9a-fA-F]+$/u

const hexDigitsToLeftPaddedBytes = (hexDigits: string) => bytesFromHex(`0x${ hexDigits.length % 2 === 0 ? hexDigits : `0${ hexDigits }` }`)

// The two readers differ on purpose and must not be unified, because MetaMask reads the message differently per method: personal_sign signs hex digits without a 0x prefix, or with 0X, as bytes, while personal_ecRecover reads them as UTF-8 text. So in MetaMask too, personal_ecRecover('12', signature) does not recover the signer of personal_sign('12'), which signed the byte 0x12; a dapp recovers it from '0x12'. Sources: normalizePersonalMessageData in https://github.com/MetaMask/core/blob/af10b426c79417350c7d5bcdf71ab0800240923d/packages/signature-controller/src/utils/normalize.ts (remove0x strips 0x and 0X) and legacyToBuffer in https://github.com/MetaMask/eth-sig-util/blob/5dea85ec66b978071fc10395fbadf1367c2c431f/src/utils.ts (only 0x-prefixed hex is bytes).

// Mirrors MetaMask personal_sign: SignatureController normalizePersonalMessageData reads an optional 0x or 0X prefix followed by at least one hex digit as bytes and anything else, including a bare 0x, as UTF-8 text, then the keyring's legacyToBuffer left-pads odd-length hex to whole bytes. The request forwarded to the signer is unchanged, so this is what a MetaMask signer signs; a signer that skips this normalization would sign unprefixed hex as text instead.
export const getPersonalSignMessageBytes = (message: string) => {
	const withoutHexPrefix = /^0x/iu.test(message) ? message.slice(2) : message
	return HEX_DIGITS_REGEX.test(withoutHexPrefix) ? hexDigitsToLeftPaddedBytes(withoutHexPrefix) : stringToBytes(message)
}

// Mirrors MetaMask personal_ecRecover: eth-json-rpc-middleware passes the message straight to eth-sig-util recoverPersonalSignature, whose legacyToBuffer reads a 0x-prefixed hex string as bytes, left-padded to whole bytes, and any other string as UTF-8 text.
export const getPersonalEcRecoverMessageBytes = (message: string) => isHexString(message) ? hexDigitsToLeftPaddedBytes(message.slice(2)) : stringToBytes(message)

// The bytes personal_sign signs, as UTF-8 text with replacement characters for bytes that are not valid UTF-8.
export const decodePersonalSignMessage = (message: string) => new TextDecoder().decode(getPersonalSignMessageBytes(message))
