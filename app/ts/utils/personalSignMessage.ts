import { bytesFromHex, stringToBytes } from './ethereumBytes.js'
import { hashMessage } from './ethereumPrimitives.js'
import { assertNever } from './typescript.js'

const HEX_DIGITS_REGEX = /^[0-9a-fA-F]+$/u

const hexDigitsToLeftPaddedBytes = (hexDigits: string) => bytesFromHex(`0x${ hexDigits.length % 2 === 0 ? hexDigits : `0${ hexDigits }` }`)

// The MetaMask personal_sign reader below and the personal_ecRecover reader (hexOrUtf8StringToBytes in ethereumBytes.ts, used by personalEcRecoverRpc.ts) differ on purpose and must not be unified, because MetaMask reads the message differently per method: personal_sign signs hex digits without a 0x prefix, or with 0X, as bytes, while personal_ecRecover reads them as UTF-8 text. So in MetaMask too, personal_ecRecover('12', signature) does not recover the signer of personal_sign('12'), which signed the byte 0x12; a dapp recovers it from '0x12'. Sources: normalizePersonalMessageData in https://github.com/MetaMask/core/blob/af10b426c79417350c7d5bcdf71ab0800240923d/packages/signature-controller/src/utils/normalize.ts (remove0x strips 0x and 0X) and legacyToBuffer in https://github.com/MetaMask/eth-sig-util/blob/5dea85ec66b978071fc10395fbadf1367c2c431f/src/utils.ts (only 0x-prefixed hex is bytes).

// Mirrors MetaMask personal_sign: SignatureController normalizePersonalMessageData reads an optional 0x or 0X prefix followed by at least one hex digit as bytes and anything else, including a bare 0x, as UTF-8 text, then the keyring's legacyToBuffer left-pads odd-length hex to whole bytes. For example, '12', '0x12' and '0X12' all sign the single byte 0x12 ('12' becomes '0x12' before signing), while 'hello' and '0x' sign their UTF-8 text. Simulated personal_sign signatures cover these bytes too.
export const getMetaMaskPersonalSignMessageBytes = (message: string) => {
	const withoutHexPrefix = /^0x/iu.test(message) ? message.slice(2) : message
	return HEX_DIGITS_REGEX.test(withoutHexPrefix) ? hexDigitsToLeftPaddedBytes(withoutHexPrefix) : stringToBytes(message)
}

// How a personal_sign message reads, judged only by its form. Canonical hex data is a lowercase 0x prefix followed by an even, non-zero number of hex digits in either case: viem, ethers and web3.js send every byte message in this form, and every wallet below signs it as those bytes, since MetaMask's keyring (legacyToBuffer in eth-sig-util), Rabby and Ambire all test hex with /^0x[0-9A-Fa-f]*$/ (isHexString in @ethereumjs/util and ethers) and then parse the digits case-insensitively (Buffer.from(hex, 'hex'), ethers getBytes, or parseInt), so a dapp cannot hide readable text by uppercasing one digit. Anything else that a wallet might read as hex is wallet-dependent, because wallets decide hex versus text in different ways: MetaMask signs '6869' and '0X6869' as the bytes of 'hi' and '0x' as its text (sourced above), while Rabby signs '6869' and '0X6869' as their text and '0x' as no bytes (personalSign in https://github.com/RabbyHub/Rabby/blob/c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a/src/background/controller/provider/controller.ts#L1475-L1482 converts anything that @ethereumjs/util isHexString rejects to its UTF-8 bytes). A 0x or 0X prefix alone is enough, whatever follows: the prefix and length are where wallets' checks differ (MetaMask signs 0X hex as bytes while Rabby and Ambire sign it as text, and MetaMask's and Rabby's keyrings left-pad odd-length hex while ethers getBytes, which Ambire signs with, rejects it), and Ambire's toPersonalSignHex (https://github.com/AmbireTech/ambire-common/blob/e6eda4c3638473f88a2e319c73346c92c67bc006/src/libs/signMessage/utils.ts) feeds anything ethers isHexString accepts to its signers, including a hardware converter that parses digit pairs with parseInt (src/utils/hexStringToUint8Array.ts there). The wallets above read a prefixed message with non-hex characters such as '0x6869zz' as text, but no dapp library sends one, so flagging it costs nothing and does not depend on every wallet rejecting its digits. Plain text is everything else. The rule depends neither on how many wallets are supported nor on which one signs.
export type PersonalSignMessageForm = 'canonicalHexData' | 'plainText' | 'walletDependent'

const CANONICAL_HEX_DATA_REGEX = /^0x(?:[0-9a-fA-F]{2})+$/u
// Both patterns run on the trimmed message, so surrounding whitespace never changes the form; trimming instead of \s* runs avoids quadratic backtracking on long website-chosen whitespace, and trim strips the same WhiteSpace and LineTerminator characters that \s matches.
const HEX_PREFIX_REGEX = /^0x/iu
const HEX_DIGITS_ONLY_REGEX = /^[0-9a-f]*$/iu

export const classifyPersonalSignMessage = (message: string): PersonalSignMessageForm => {
	if (CANONICAL_HEX_DATA_REGEX.test(message)) return 'canonicalHexData'
	// An empty message is zero bytes whether a wallet reads it as text or as hex.
	if (message === '') return 'plainText'
	const trimmed = message.trim()
	return HEX_PREFIX_REGEX.test(trimmed) || HEX_DIGITS_ONLY_REGEX.test(trimmed) ? 'walletDependent' : 'plainText'
}

// The bytes a personal_sign signature covers, or undefined when they depend on which wallet signs. Simulation mode signs locally with MetaMask's reading. Signing mode forwards the message unchanged to whichever wallet the page uses, so it only shows and hashes messages whose bytes every wallet agrees on (see classifyPersonalSignMessage); the popup shows any other message as written, without a message hash, and flags it.
export const getPersonalSignMessageBytes = (message: string, simulationMode: boolean) => {
	if (simulationMode) return getMetaMaskPersonalSignMessageBytes(message)
	const form = classifyPersonalSignMessage(message)
	switch (form) {
		case 'canonicalHexData': return hexDigitsToLeftPaddedBytes(message.slice(2))
		case 'plainText': return stringToBytes(message)
		case 'walletDependent': return undefined
		default: return assertNever(form)
	}
}

// The bytes the signature covers as UTF-8 text, with replacement characters for bytes that are not valid UTF-8, or the message exactly as written when those bytes depend on which wallet signs.
export const decodePersonalSignMessage = (message: string, simulationMode: boolean) => {
	const signedBytes = getPersonalSignMessageBytes(message, simulationMode)
	return signedBytes === undefined ? message : new TextDecoder().decode(signedBytes)
}

// The message hash a personal_sign signature covers, or undefined when its bytes depend on which wallet signs. The popup shows this hash and simulated signing signs it, so both go through this one function and what the user sees is what the simulation signs.
export const getPersonalSignMessageHash = (message: string, simulationMode: boolean) => {
	const signedBytes = getPersonalSignMessageBytes(message, simulationMode)
	return signedBytes === undefined ? undefined : hashMessage({ raw: signedBytes })
}
