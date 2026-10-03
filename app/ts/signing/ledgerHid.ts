import { createLedgerResponseDecoder, frameLedgerApdu } from './ledgerFraming.js'
import type { LedgerCommand } from './ledgerTypedData.js'

export interface LedgerHidDevice extends EventTarget {
	readonly vendorId: number
	readonly productId: number
	readonly productName: string
	readonly opened: boolean
	readonly collections: readonly { readonly usagePage: number }[]
	open(): Promise<void>
	close(): Promise<void>
	sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>
}

export interface LedgerHid extends EventTarget {
	requestDevice(options: { filters: readonly { vendorId: number, usagePage: number }[] }): Promise<readonly LedgerHidDevice[]>
	getDevices(): Promise<readonly LedgerHidDevice[]>
}

declare global {
	interface Navigator { readonly hid?: LedgerHid }
}

const requireReconnect = new WeakSet<EventTarget>()
const observedManagers = new WeakSet<LedgerHid>()

export function getLedgerHid(): LedgerHid {
	if (typeof navigator === 'undefined' || navigator.hid === undefined || navigator.locks === undefined) throw new Error('Direct Ledger signing requires a browser with WebHID and Web Locks support, such as desktop Chrome or Chromium.')
	return navigator.hid
}

export async function selectLedgerDevice(): Promise<LedgerHidDevice> {
	const hid = getLedgerHid()
	const devices = await hid.requestDevice({ filters: [{ vendorId: 0x2c97, usagePage: 0xffa0 }] })
	const device = devices[0]
	if (device === undefined) throw new Error('Ledger device selection was cancelled')
	validateDevice(device)
	return device
}

function validateDevice(device: LedgerHidDevice) {
	if (device.vendorId !== 0x2c97 || !device.collections.some((collection) => collection.usagePage === 0xffa0)) throw new Error('Selected HID device is not a supported Ledger interface')
}

export function encodeLedgerCommand(command: LedgerCommand): Uint8Array<ArrayBuffer> {
	for (const byte of [command.instruction, command.p1, command.p2]) if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('Invalid Ledger command header')
	if (command.data.length > 255) throw new Error('Ledger APDU data exceeds 255 bytes')
	const apdu = new Uint8Array(5 + command.data.length)
	apdu.set([0xe0, command.instruction, command.p1, command.p2, command.data.length])
	apdu.set(command.data, 5)
	return apdu
}

function checkStatus(response: Uint8Array): Uint8Array {
	const status = new DataView(response.buffer, response.byteOffset, response.byteLength).getUint16(response.length - 2)
	if (status === 0x9000) return response.slice(0, -2)
	if (status === 0x6985) throw Object.assign(new Error('Ledger approval was rejected on the device'), { ledgerStatus: status })
	if (status === 0x5515) throw new Error('Unlock your Ledger and open the Ethereum app')
	if (status === 0x6d00 || status === 0x6e00) throw new Error('Open a compatible Ethereum app on your Ledger')
	if (status === 0x6a80) throw new Error('The Ledger Ethereum app does not support this payload or its current signing settings')
	throw new Error(`Ledger returned status 0x${ status.toString(16).padStart(4, '0') }`)
}

export type LedgerExchange = (command: LedgerCommand) => Promise<Uint8Array>

/** Call only under the extension-wide Web Lock. Exported separately for deterministic transport tests. */
export async function runLedgerHidSession<T>(hid: LedgerHid, device: LedgerHidDevice, signal: AbortSignal, operation: (exchange: LedgerExchange) => Promise<T>, timeoutMs = 180000): Promise<T> {
	validateDevice(device)
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error('Invalid Ledger exchange timeout')
	if (!observedManagers.has(hid)) {
		observedManagers.add(hid)
		hid.addEventListener('disconnect', (event) => {
			if ('device' in event && event.device instanceof EventTarget) requireReconnect.delete(event.device)
		})
	}
	if (requireReconnect.has(device)) throw new Error('Disconnect and reconnect your Ledger, then reopen Ethereum to clear the previous signing session')
	signal.throwIfAborted()
	const firstChannel = crypto.getRandomValues(new Uint16Array(1))[0]
	if (firstChannel === undefined) throw new Error('Could not allocate Ledger channel')
	let channelCount = 0
	await device.open()
	let closed = false
	let deviceDisconnected = false
	let currentFailure: ((error: unknown) => void) | undefined
	let currentPacket: ((packet: Uint8Array) => void) | undefined
	const fail = (error: unknown) => {
		closed = true
		requireReconnect.add(device)
		currentFailure?.(error)
	}
	const aborted = () => fail(signal.reason ?? new Error('Ledger signing cancelled'))
	const disconnected = (event: Event) => {
		if ('device' in event && event.device === device) {
			deviceDisconnected = true
			fail(new Error('Ledger disconnected. Reconnect it and reopen Ethereum.'))
			requireReconnect.delete(device)
		}
	}
	const report = (event: Event) => {
		if (!('data' in event) || !(event.data instanceof DataView) || !('reportId' in event) || event.reportId !== 0) return fail(new Error('Invalid Ledger input report'))
		if (currentPacket === undefined) return fail(new Error('Unexpected Ledger response outside an exchange'))
		currentPacket(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
	}
	hid.addEventListener('disconnect', disconnected)
	device.addEventListener('inputreport', report)
	signal.addEventListener('abort', aborted, { once: true })
	const exchange: LedgerExchange = async (command) => {
		signal.throwIfAborted()
		if (closed) throw new Error('Ledger session is closed')
		if (currentFailure !== undefined) {
			const error = new Error('Ledger exchanges must be serialized')
			fail(error)
			throw error
		}
		// A random starting point plus a bounded counter never reuses a completed channel in this session.
		if (channelCount >= 65536) throw new Error('Ledger session exhausted its response channels; open a new session')
		const channel = (firstChannel + channelCount) % 65536
		channelCount += 1
		const packets = frameLedgerApdu(channel, encodeLedgerCommand(command))
		const decode = createLedgerResponseDecoder(channel)
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const response = await new Promise<Uint8Array>((resolve, reject) => {
				let received: Uint8Array | undefined
				let sent = false
				currentFailure = reject
				currentPacket = (packet) => {
					try {
						const result = decode(packet)
						if (result !== undefined) {
							received = result
							if (sent) resolve(result)
						}
					} catch (error) { fail(error) }
				}
				timer = setTimeout(() => fail(new Error('Ledger response timed out; disconnect and reconnect the device')), timeoutMs)
				const send = async () => {
					for (const packet of packets) {
						signal.throwIfAborted()
						if (closed) throw new Error('Ledger session is closed')
						await device.sendReport(0, packet.slice())
					}
					sent = true
					if (received !== undefined) resolve(received)
				}
				void send().catch(fail)
			})
			signal.throwIfAborted()
			if (closed) throw new Error('Ledger session ended before its response could be used')
			return checkStatus(response)
		} finally {
			clearTimeout(timer)
			currentFailure = undefined
			currentPacket = undefined
		}
	}
	try {
		signal.throwIfAborted()
		const result = await operation(exchange)
		signal.throwIfAborted()
		if (closed) throw new Error('Ledger session closed before completion')
		return result
	} catch (error) {
		const cleanRejection = error instanceof Error && 'ledgerStatus' in error && error.ledgerStatus === 0x6985
		if (!deviceDisconnected && !cleanRejection) requireReconnect.add(device)
		throw error
	} finally {
		closed = true
		signal.removeEventListener('abort', aborted)
		hid.removeEventListener('disconnect', disconnected)
		device.removeEventListener('inputreport', report)
		await device.close()
	}
}

export async function withLedgerDevice<T>(device: LedgerHidDevice, signal: AbortSignal, operation: (exchange: LedgerExchange) => Promise<T>): Promise<T> {
	const hid = getLedgerHid()
	return await navigator.locks.request('interceptor-ledger-signing', { mode: 'exclusive', signal }, async () => await runLedgerHidSession(hid, device, signal, operation))
}
