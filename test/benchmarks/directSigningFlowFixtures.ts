import { secp256k1 } from '@noble/curves/secp256k1'
import encodeQR from 'qr'
import type { DirectSigningRecord } from '../../app/ts/types/directSigning.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../../app/ts/utils/ethereumBytes.js'
import { prepareDirectPayload } from '../../app/ts/signing/backend.js'
import { frameLedgerApdu } from '../../app/ts/signing/ledgerFraming.js'
import { encodeLedgerCommand } from '../../app/ts/signing/ledgerHid.js'
import { signWithLedger } from '../../app/ts/signing/ledgerEthereum.js'
import { encodeAirGapCbor, type AirGapCbor } from '../../app/ts/signing/airgapCbor.js'
import { createAirGapUrEncoder } from '../../app/ts/signing/airgapUr.js'
import type { CdpConnection } from './chromeHarness.js'

// Public test key only; scripted HID is not a physical Ledger or emulator.
const key = bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001')
const address = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
const path = 'm/44\'/60\'/0\'/0/0'

export async function installFlowCamera(page: CdpConnection, revision: string, signature: Uint8Array) {
	const cbor = encodeAirGapCbor(new Map<bigint, AirGapCbor>([[1n, { tag: 37n, value: bytesFromHex(ensureHex(`0x${ revision.replaceAll('-', '') }`)) }], [2n, signature]]))
	const encoder = createAirGapUrEncoder('eth-signature', cbor, 500)
	const image = encodeQR(encoder.part(1).toUpperCase(), 'data-url', { scale: 6, border: 4, ecc: 'medium' })
	await page.evaluate(`(async () => { const image = new Image(); image.src = ${ JSON.stringify(image) }; await image.decode(); navigator.mediaDevices.getUserMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480; const c = canvas.getContext('2d'); c.fillStyle = 'white'; c.fillRect(0,0,640,480); c.drawImage(image,80,0,480,480); return canvas.captureStream(10); }; })()`)
}
export async function installFlowLedger(page: CdpConnection, record: DirectSigningRecord, signature: Uint8Array, failure: 'reject' | 'disconnect' | undefined) {
	const script: { request: number[][], response: number[][], signing: boolean }[] = []
	const publicKey = secp256k1.getPublicKey(key, false)
	await signWithLedger(async (command) => {
		const signing = command.instruction === 4 || command.instruction === 8 || command.instruction === 12
		const response = command.instruction === 6 ? Uint8Array.of(1, 1, 22, 3) : command.instruction === 2 ? Uint8Array.from([65, ...publicKey, 40, ...new TextEncoder().encode(address.slice(2))]) : signing ? Uint8Array.from([signature[64] ?? 27, ...signature.slice(0, 64)]) : new Uint8Array()
		script.push({ request: frameLedgerApdu(0, encodeLedgerCommand(command)).map((p) => [...p]), response: frameLedgerApdu(0, Uint8Array.from([...response, 0x90, 0])).map((p) => [...p]), signing })
		return response
	}, { address: ensureHex(address), publicKey: bytesToHex(publicKey), derivationPath: path }, prepareDirectPayload(record.input))
	await page.evaluate(`(() => {
		const script = ${ JSON.stringify(script) }; let command = 0, packetIndex = 0, failure = ${ JSON.stringify(failure) };
		const device = Object.assign(new EventTarget(), { vendorId: 0x2c97, productId: 0x0004, productName: 'Public-key signing fixture', collections: [{usagePage: 0xffa0}], opened: false,
			async open() { this.opened = true; command = 0; packetIndex = 0; }, async close() { this.opened = false; },
			async sendReport(id, packet) { const step = script[command]; const expected = step?.request[packetIndex]; if (!expected || packet.some((b,i) => i > 1 && b !== expected[i])) throw new Error('HID command differs from reviewed fixture');
				if (++packetIndex !== step.request.length) return; packetIndex = 0; command++;
				let frames = step.response;
				if (step.signing && failure === 'disconnect') { failure = undefined; navigator.hid.dispatchEvent(Object.assign(new Event('disconnect'), {device:this})); return; }
				if (step.signing && failure === 'reject') { failure = undefined; frames = ${ JSON.stringify(frameLedgerApdu(0, Uint8Array.of(0x69, 0x85)).map((p) => [...p])) }; }
				for (const frame of frames) { const data = Uint8Array.from(frame); data[0] = packet[0]; data[1] = packet[1]; this.dispatchEvent(Object.assign(new Event('inputreport'), { data: new DataView(data.buffer), reportId: 0 })); }
			}
		}); Object.defineProperty(navigator, 'hid', { configurable: true, value: Object.assign(new EventTarget(), { requestDevice: async () => [device], getDevices: async () => [device] }) });
	})()`)
}
