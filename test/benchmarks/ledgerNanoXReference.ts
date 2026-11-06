// Opt-in emulator check. Never point automated approval at physical hardware or production accounts.
import * as funtypes from 'funtypes'
import { encodeLedgerCommand, type LedgerExchange } from '../../app/ts/signing/ledgerHid.js'
import { checkLedgerEthereumApp, readLedgerAccount, signWithLedger } from '../../app/ts/signing/ledgerEthereum.js'
import { preparePersonalSigningPayload, prepareTransactionSigningPayload, prepareTypedDataSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../../app/ts/utils/ethereumBytes.js'

const endpoint = 'http://127.0.0.1:5010'
const Screen = funtypes.Object({ events: funtypes.Array(funtypes.Object({ text: funtypes.String })) })
const ApduResponse = funtypes.Object({ data: funtypes.String })
const pause = () => new Promise((resolve) => setTimeout(resolve, 150))
const request = async (path: string, body?: unknown) => {
	const response = await fetch(`${ endpoint }${ path }`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) })
	if (!response.ok) throw new Error(`Speculos ${ path }: HTTP ${ response.status }`)
	return await response.json()
}
const button = async (name: string) => { await request(`/button/${ name }`, { action: 'press-and-release' }); await pause() }
const screen = async () => Screen.parse(await request('/events?currentscreenonly=true')).events.map((event) => event.text)
const exchange: LedgerExchange = async (command) => {
	const reply = ApduResponse.parse(await request('/apdu', { data: bytesToHex(encodeLedgerCommand(command)).slice(2) }))
	const bytes = bytesFromHex(ensureHex(`0x${ reply.data }`))
	if (bytes.at(-2) !== 0x90 || bytes.at(-1) !== 0) throw new Error(`Ledger status ${ reply.data.slice(-4) }`)
	return bytes.slice(0, -2)
}
const app = await checkLedgerEthereumApp(exchange)
if (app.version !== '1.22.3') throw new Error(`Expected Ethereum 1.22.3; received ${ app.version }`)
const account = await readLedgerAccount(exchange, 'm/44\'/60\'/0\'/0/0', false)
if (account.address !== '0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D') throw new Error('Use the default Speculos public test seed')
// Explicitly configure the emulator, not the extension or a real device.
if (!(await screen()).includes('app is ready')) throw new Error('Start Speculos at the Ethereum home screen')
await button('right')
await button('both')
if (!(await screen()).includes('Blind signing')) throw new Error('Unexpected Nano X settings layout')
if ((await screen()).includes('Disabled')) await button('both')
await button('right')
await button('right')
if (!(await screen()).includes('Raw messages')) throw new Error('Unexpected Nano X raw-message setting')
const rawMessages = process.argv.includes('--raw-messages')
if ((await screen()).includes(rawMessages ? 'Disabled' : 'Enabled')) await button('both')
let returnedHome = false
for (let index = 0; index < 12; index++) {
	await button('right')
	if ((await screen()).includes('Back')) { await button('both'); returnedHome = true; break }
}
if (!returnedHome) throw new Error('Could not leave emulator settings')
const payloads = [
	prepareTransactionSigningPayload(serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, to: account.address, value: 1000000000000000n }), account.address, 1n),
	preparePersonalSigningPayload('0x48656c6c6f204c6564676572', account.address),
	prepareTypedDataSigningPayload(JSON.stringify({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Message: [{ name: 'contents', type: 'string' }] }, primaryType: 'Message', domain: { name: 'Interceptor', chainId: 1 }, message: { contents: 'Hello Ledger' } }), account.address, 1n),
]
const transcripts: { method: string, screens: string[][], result: string }[] = []
for (const payload of payloads) {
	let done = false
	const screens: string[][] = []
	const signed = signWithLedger(exchange, account, payload).then((result) => ({ result }), (error: unknown) => ({ error })).finally(() => { done = true })
	const deadline = Date.now() + 120000
	while (!done && Date.now() < deadline) {
		await pause()
		const current = await screen()
		if (current.length === 0 || current.includes('app is ready') || current.includes('App settings')) continue
		if (JSON.stringify(screens.at(-1)) !== JSON.stringify(current)) screens.push(current)
		const approve = current.some((text) => ['Blind signing ahead', 'Sign transaction', 'Sign message', 'Transaction signed', 'Message signed'].includes(text))
		await button(approve ? 'both' : 'right')
	}
	if (!done) throw new Error(`Timed out reviewing ${ payload.method }`)
	const outcome = await signed
	if ('error' in outcome) throw outcome.error
	transcripts.push({ method: payload.method, screens, result: outcome.result })
	// Dismiss the success screen before the next request.
	for (let index = 0; index < 10 && !(await screen()).includes('app is ready'); index++) await button('both')
}
console.info(JSON.stringify({ model: 'Nano X', ethereumApp: app.version, speculos: '0.27.0', rawMessages, account, transcripts }, undefined, 2))
