import { parseDerivationPath } from '../utils/derivationPath.js'
// Wire format: LedgerHQ/ledgerjs packages/devices/src/hid-framing.ts.
const PACKET_SIZE = 64
const TAG = 0x05
const MAX_APDU_BYTES = 65535

function validateChannel(channel: number) {
	if (!Number.isInteger(channel) || channel < 0 || channel > 65535) throw new Error('Invalid Ledger HID channel')
}

export function frameLedgerApdu(channel: number, apdu: Uint8Array): readonly Uint8Array[] {
	validateChannel(channel)
	if (apdu.length === 0 || apdu.length > MAX_APDU_BYTES) throw new Error('Invalid Ledger APDU length')
	const packets: Uint8Array[] = []
	let offset = 0
	while (offset < apdu.length) {
		const packet = new Uint8Array(PACKET_SIZE)
		const view = new DataView(packet.buffer)
		view.setUint16(0, channel)
		packet[2] = TAG
		view.setUint16(3, packets.length)
		const headerLength = packets.length === 0 ? 7 : 5
		if (packets.length === 0) view.setUint16(5, apdu.length)
		const count = Math.min(PACKET_SIZE - headerLength, apdu.length - offset)
		packet.set(apdu.subarray(offset, offset + count), headerLength)
		offset += count
		packets.push(packet)
	}
	return packets
}

/** One decoder per exchange. A malformed packet permanently invalidates it. */
export function createLedgerResponseDecoder(channel: number, maximumBytes = MAX_APDU_BYTES) {
	validateChannel(channel)
	if (!Number.isInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > MAX_APDU_BYTES) throw new Error('Invalid Ledger response limit')
	let sequence = 0
	let response: Uint8Array | undefined
	let offset = 0
	let finished = false
	const reject = (message: string): never => {
		finished = true
		response = undefined
		throw new Error(message)
	}
	return (packet: Uint8Array): Uint8Array | undefined => {
		if (finished) throw new Error('Ledger response decoder is closed')
		if (packet.length !== PACKET_SIZE) return reject('Invalid Ledger HID packet length')
		const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
		if (view.getUint16(0) !== channel) return reject('Unexpected Ledger HID channel')
		if (packet[2] !== TAG) return reject('Unexpected Ledger HID tag')
		if (view.getUint16(3) !== sequence) return reject('Unexpected Ledger HID sequence')
		const headerLength = sequence === 0 ? 7 : 5
		if (sequence === 0) {
			const length = view.getUint16(5)
			if (length < 2 || length > maximumBytes) return reject('Invalid Ledger response length')
			response = new Uint8Array(length)
		}
		if (response === undefined) return reject('Ledger response was not initialized')
		const count = Math.min(PACKET_SIZE - headerLength, response.length - offset)
		response.set(packet.subarray(headerLength, headerLength + count), offset)
		offset += count
		sequence += 1
		if (offset !== response.length) return undefined
		finished = true
		return response
	}
}

/** Absolute, concrete BIP-32 paths only; ranges and wildcards cannot identify an account. */
export function encodeLedgerDerivationPath(path: string): Uint8Array {
	const components = parseDerivationPath(path)
	if (components === undefined) throw new Error('Invalid Ledger derivation path')
	const encoded = new Uint8Array(1 + components.length * 4)
	encoded[0] = components.length
	const view = new DataView(encoded.buffer)
	components.forEach(({ index, hardened }, position) => { view.setUint32(1 + position * 4, index + (hardened ? 0x80000000 : 0)) })
	return encoded
}
