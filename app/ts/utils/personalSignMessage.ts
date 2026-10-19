import { bytesFromHex, bytesToHex, isHexString, stringToBytes } from './ethereumBytes.js'

const HEX_DIGITS_REGEX = /^[0-9a-fA-F]+$/u

const hexDigitsToLeftPaddedBytes = (hexDigits: string) => bytesFromHex(`0x${ hexDigits.length % 2 === 0 ? hexDigits : `0${ hexDigits }` }`)

// The MetaMask personal_sign and personal_ecRecover readers differ on purpose and must not be unified, because MetaMask reads the message differently per method: personal_sign signs hex digits without a 0x prefix, or with 0X, as bytes, while personal_ecRecover reads them as UTF-8 text. So in MetaMask too, personal_ecRecover('12', signature) does not recover the signer of personal_sign('12'), which signed the byte 0x12; a dapp recovers it from '0x12'. Sources: normalizePersonalMessageData in https://github.com/MetaMask/core/blob/af10b426c79417350c7d5bcdf71ab0800240923d/packages/signature-controller/src/utils/normalize.ts (remove0x strips 0x and 0X) and legacyToBuffer in https://github.com/MetaMask/eth-sig-util/blob/5dea85ec66b978071fc10395fbadf1367c2c431f/src/utils.ts (only 0x-prefixed hex is bytes).

// Mirrors MetaMask personal_sign: SignatureController normalizePersonalMessageData reads an optional 0x or 0X prefix followed by at least one hex digit as bytes and anything else, including a bare 0x, as UTF-8 text, then the keyring's legacyToBuffer left-pads odd-length hex to whole bytes. For example, '12', '0x12' and '0X12' all sign the single byte 0x12 ('12' becomes '0x12' before signing), while 'hello' and '0x' sign their UTF-8 text. Simulated personal_sign signatures cover these bytes too.
export const getMetaMaskPersonalSignMessageBytes = (message: string) => {
	const withoutHexPrefix = /^0x/iu.test(message) ? message.slice(2) : message
	return HEX_DIGITS_REGEX.test(withoutHexPrefix) ? hexDigitsToLeftPaddedBytes(withoutHexPrefix) : stringToBytes(message)
}

// Mirrors MetaMask personal_ecRecover: eth-json-rpc-middleware passes the message straight to eth-sig-util recoverPersonalSignature, whose legacyToBuffer reads a 0x-prefixed hex string as bytes, left-padded to whole bytes, and any other string as UTF-8 text.
export const getPersonalEcRecoverMessageBytes = (message: string) => isHexString(message) ? hexDigitsToLeftPaddedBytes(message.slice(2)) : stringToBytes(message)

// Mirrors Rabby personal_sign, which reads the message like personal_ecRecover above: its provider controller passes a message matching /^0x[0-9A-Fa-f]*$/ (@ethereumjs/util isHexString, so a lowercase 0x only, and a bare 0x is no bytes) to the keyring as hex and converts anything else to its UTF-8 bytes, then the keyring signs with eth-sig-util personalSign, whose legacyToBuffer left-pads odd-length hex. So unlike MetaMask, Rabby signs '12' and '0X12' as their text and '0x' as no bytes. Source: personalSign in https://github.com/RabbyHub/Rabby/blob/c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a/src/background/controller/provider/controller.ts#L1475-L1482
const getRabbyPersonalSignMessageBytes = getPersonalEcRecoverMessageBytes

// The bytes a personal_sign signature covers, or undefined when they depend on which wallet signs. Simulation mode signs locally with MetaMask's reading. Signing mode forwards the message unchanged, and MetaMask and Rabby (sourced above) sign hex-like messages such as '6869', '0X6869' and '0x' as different bytes; the Interceptor cannot reliably tell which wallet, or which frame's wallet, will sign, so it does not guess and the popup shows such a message as written, without a message hash, and flags it.
export const getPersonalSignMessageBytes = (message: string, simulationMode: boolean) => {
	const metaMaskBytes = getMetaMaskPersonalSignMessageBytes(message)
	if (simulationMode) return metaMaskBytes
	return bytesToHex(metaMaskBytes) === bytesToHex(getRabbyPersonalSignMessageBytes(message)) ? metaMaskBytes : undefined
}

// The bytes the signature covers as UTF-8 text, with replacement characters for bytes that are not valid UTF-8, or the message exactly as written when those bytes depend on which wallet signs.
export const decodePersonalSignMessage = (message: string, simulationMode: boolean) => {
	const signedBytes = getPersonalSignMessageBytes(message, simulationMode)
	return signedBytes === undefined ? message : new TextDecoder().decode(signedBytes)
}
