import { MAX_AIRGAP_CBOR_BYTES } from './airgapCbor.js'

// Protocol alphabet from Blockchain Commons BCR-2020-012 (CC BY 4.0).
// https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-012-bytewords.md
const words = (
	'able acid also apex aqua arch atom aunt away axis back bald barn belt beta bias ' +
	'blue body brag brew bulb buzz calm cash cats chef city claw code cola cook cost ' +
	'crux curl cusp cyan dark data days deli dice diet door down draw drop drum dull ' +
	'duty each easy echo edge epic even exam exit eyes fact fair fern figs film fish ' +
	'fizz flap flew flux foxy free frog fuel fund gala game gear gems gift girl glow ' +
	'good gray grim guru gush gyro half hang hard hawk heat help high hill holy hope ' +
	'horn huts iced idea idle inch inky into iris iron item jade jazz join jolt jowl ' +
	'judo jugs jump junk jury keep keno kept keys kick kiln king kite kiwi knob lamb ' +
	'lava lazy leaf legs liar limp lion list logo loud love luau luck lung main many ' +
	'math maze memo menu meow mild mint miss monk nail navy need news next noon note ' +
	'numb obey oboe omit onyx open oval owls paid part peck play plus poem pool pose ' +
	'puff puma purr quad quiz race ramp real redo rich road rock roof ruby ruin runs ' +
	'rust safe saga scar sets silk skew slot soap solo song stub surf swan taco task ' +
	'taxi tent tied time tiny toil tomb toys trip tuna twin ugly undo unit urge user ' +
	'vast very veto vial vibe view visa void vows wall wand warm wasp wave waxy webs ' +
	'what when whiz wolf work yank yawn yell yoga yurt zaps zero zest zinc zone zoom'
).split(' ')
const minimalWords = words.map((word) => word.slice(0, 1) + word.slice(-1))
const indices = new Map(minimalWords.map((word, index) => [word, index]))

export function airGapCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff
	for (const byte of bytes) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
	}
	return (crc ^ 0xffffffff) >>> 0
}

export function encodeAirGapBytewords(bytes: Uint8Array): string {
	if (bytes.length === 0 || bytes.length > MAX_AIRGAP_CBOR_BYTES) throw new Error('AirGap Bytewords payload size is out of bounds')
	const checksum = new Uint8Array(4)
	new DataView(checksum.buffer).setUint32(0, airGapCrc32(bytes))
	return [...bytes, ...checksum].map((byte) => minimalWords[byte]).join('')
}

export function decodeAirGapBytewords(text: string): Uint8Array {
	if (text.length < 10 || text.length > (MAX_AIRGAP_CBOR_BYTES + 4) * 2 || text.length % 2 !== 0) throw new Error('AirGap Bytewords payload size is out of bounds')
	if (!/^[a-zA-Z]+$/u.test(text)) throw new Error('Invalid AirGap Bytewords characters')
	const normalized = text.toLowerCase()
	const decoded = new Uint8Array(normalized.length / 2)
	for (let index = 0; index < decoded.length; index += 1) {
		const byte = indices.get(normalized.slice(index * 2, index * 2 + 2))
		if (byte === undefined) throw new Error('Unknown AirGap Bytewords pair')
		decoded[index] = byte
	}
	const payload = decoded.subarray(0, decoded.length - 4)
	const checksum = new DataView(decoded.buffer).getUint32(payload.length)
	if (airGapCrc32(payload) !== checksum) throw new Error('AirGap Bytewords checksum mismatch')
	return payload
}
