import encodeQR from 'qr'
import { addr } from 'micro-eth-signer'
import { secp256k1 } from '@noble/curves/secp256k1'
import { frameLedgerApdu } from '../../app/ts/signing/ledgerFraming.js'
import { encodeAirGapCbor, type AirGapCbor } from '../../app/ts/signing/airgapCbor.js'
import { createAirGapUrEncoder } from '../../app/ts/signing/airgapUr.js'
import { bytesFromHex } from '../../app/ts/utils/ethereumBytes.js'
import type { CdpConnection } from './chromeHarness.js'

/** Public test keys only. This mock answers discovery/verification, never signing commands. */
export async function installScreenshotLedger(page: CdpConnection) {
	const replies = Array.from({ length: 5 }, (_, index) => {
		const publicKey = secp256k1.getPublicKey(
			bytesFromHex(
				`0x${BigInt(index + 2)
					.toString(16)
					.padStart(64, '0')}`
			),
			false
		)
		const address = addr.fromPublicKey(publicKey).slice(2)
		return frameLedgerApdu(0, Uint8Array.from([65, ...publicKey, 40, ...new TextEncoder().encode(address), 0x90, 0])).map((packet) => Array.from(packet))
	})
	const configuration = frameLedgerApdu(0, Uint8Array.of(0, 1, 9, 19, 0x90, 0)).map((packet) => Array.from(packet))
	await page.evaluate(`(() => {
		const replies = ${JSON.stringify(replies)};
		const device = Object.assign(new EventTarget(), {
			vendorId: 0x2c97, productId: 1, productName: 'Screenshot fixture (not a physical Ledger)', collections: [{usagePage: 0xffa0}], opened: false,
			async open() { this.opened = true; }, async close() { this.opened = false; },
			async sendReport(id, packet) {
				const instruction = packet[8];
				if (instruction !== 6 && instruction !== 2) throw new Error('Screenshot Ledger must never sign');
				const index = instruction === 2 ? new DataView(packet.buffer, packet.byteOffset).getUint32(21) & 0x7fffffff : 0;
				const frames = instruction === 6 ? ${JSON.stringify(configuration)} : replies[index];
				if (!frames) throw new Error('Unknown fixture account');
				for (const frame of frames) {
					const bytes = Uint8Array.from(frame); bytes[0] = packet[0]; bytes[1] = packet[1];
					this.dispatchEvent(Object.assign(new Event('inputreport'), {data: new DataView(bytes.buffer), reportId: 0}));
				}
			}
		});
		Object.defineProperty(navigator, 'hid', {configurable: true, value: Object.assign(new EventTarget(), {requestDevice: async () => [device], getDevices: async () => [device]})});
	})()`)
}

/** Feed a real QR image through the scanner using a synthetic camera stream. */
export async function installScreenshotAccountCamera(page: CdpConnection) {
	const key = bytesFromHex(`0x${'1'.padStart(64, '0')}`)
	const path = new Map<bigint, AirGapCbor>([
		[1n, [44n, true, 60n, true, 0n, true, 0n, false, 0n, false]],
		[2n, 0xf23f9fd2n]
	])
	const account = new Map<bigint, AirGapCbor>([
		[3n, secp256k1.getPublicKey(key, true)],
		[6n, { tag: 304n, value: path }]
	])
	const exported = new Map<bigint, AirGapCbor>([
		[1n, 0xf23f9fd2n],
		[2n, [{ tag: 303n, value: account }]]
	])
	const encoder = createAirGapUrEncoder('crypto-account', encodeAirGapCbor(exported), 500)
	const qr = encodeQR(encoder.part(1).toUpperCase(), 'data-url', { scale: 6, border: 4, ecc: 'medium' })
	await page.evaluate(`(async () => {
		const image = new Image(); image.src = ${JSON.stringify(qr)}; await image.decode();
		navigator.mediaDevices.getUserMedia = async () => {
			const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
			const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 640, 480); context.drawImage(image, 80, 0, 480, 480);
			return canvas.captureStream(10);
		};
	})()`)
}
