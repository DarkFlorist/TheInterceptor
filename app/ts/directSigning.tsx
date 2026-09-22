import { openSigningWalletSetup } from './components/subcomponents/SigningWalletSummary.js'
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { DirectSigningRecord, type SigningPageRequest } from './types/directSigning.js'
import { sendSigningPageRequest } from './signing/pageMessages.js'
import { prepareDirectPayload, signingWalletDescription } from './signing/backend.js'
import { selectLedgerDevice, withLedgerDevice } from './signing/ledgerHid.js'
import { signWithLedger } from './signing/ledgerEthereum.js'
import { encodeAirGapSigningRequest, verifyAirGapSigningResponse } from './signing/airgapEthereum.js'
import { createAirGapUrDecoder } from './signing/airgapUr.js'
import { AnimatedSigningQr, SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { ensureHex } from './utils/ethereumBytes.js'
import { parseTransaction } from './utils/ethereumTransactions.js'

function DirectSigningPage() {
	const id = new URLSearchParams(location.search).get('id') ?? ''
	const [record, setRecord] = useState<DirectSigningRecord>()
	const [error, setError] = useState<string>()
	const [status, setStatus] = useState('Loading request…')
	const [busy, setBusy] = useState(false)
	const [qr, setQr] = useState<Uint8Array>()
	const [scanning, setScanning] = useState(false)
	const [nonce, setNonce] = useState('0')
	const [gas, setGas] = useState('21000')
	const [maxFee, setMaxFee] = useState('0')
	const [priority, setPriority] = useState('0')
	const controller = useRef(new AbortController())
	const decoder = useRef(createAirGapUrDecoder('eth-signature'))
	const command = async (request: SigningPageRequest) => {
		const reply = await sendSigningPageRequest(request)
		const next = DirectSigningRecord.parse(reply.record)
		setRecord(next)
		return next
	}
	const run = async (operation: () => Promise<void>) => {
		setBusy(true); setError(undefined)
		try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Signing failed') } finally { setBusy(false) }
	}
	useEffect(() => {
		void run(async () => {
			const next = await command({ method: 'signing_get', id })
			if (next.input.method === 'eth_sendTransaction') {
				const transaction = parseTransaction(ensureHex(next.input.data))
				setNonce(String(transaction.nonce)); setGas(String(transaction.gas)); setMaxFee(String(transaction.maxFeePerGas)); setPriority(String(transaction.maxPriorityFeePerGas))
			}
			setStatus(next.phase === 'approved' ? 'Approval recovered. Resume this exact request or cancel it.' : 'Review the exact payload below before approving.')
		})
		return () => controller.current.abort(new Error('Signing page closed'))
	}, [])
	const sign = () => run(async () => {
		if (record === undefined) return
		// Device selection requires the click's user activation, before asynchronous extension messages.
		const device = record.binding.wallet.type === 'ledger' ? await selectLedgerDevice() : undefined
		const approved = record.phase === 'review' ? await command({ method: 'signing_approve', id, revision: record.revision }) : record
		if (approved.phase !== 'approved') throw new Error('This request is no longer waiting for a signature')
		const wallet = approved.binding.wallet
		const payload = prepareDirectPayload(approved.input)
		if (wallet.type === 'ledger' && device !== undefined) {
			setStatus('Unlock Ledger and open Ethereum. Check the account and approve on your device.')
			controller.current = new AbortController()
			await withLedgerDevice(device, controller.current.signal, async (exchange) => {
				const current = DirectSigningRecord.parse((await sendSigningPageRequest({ method: 'signing_get', id })).record)
				if (current.phase !== 'approved' || current.revision !== approved.revision) throw new Error('Another signing window completed or cancelled this approval')
				const result = await signWithLedger(exchange, { address: ensureHex(approved.input.address), publicKey: ensureHex(wallet.publicKey), derivationPath: wallet.derivationPath }, payload)
				setStatus('Verifying signature against the approved account and exact payload…')
				await command({ method: 'signing_result', id, revision: approved.revision, result })
			})
			setStatus(payload.method === 'eth_sendTransaction' ? 'Signature verified. Review the fees and broadcast when ready.' : 'Message signature verified and returned to the originating application.')
		} else if (wallet.type === 'airgap') {
			setQr(encodeAirGapSigningRequest({ address: ensureHex(approved.input.address), publicKey: ensureHex(wallet.publicKey), derivationPath: wallet.derivationPath, sourceFingerprint: wallet.sourceFingerprint }, payload, approved.input.chainId, approved.revision))
			decoder.current = createAirGapUrDecoder('eth-signature')
			setStatus('Scan the request with AirGap Vault, review it offline, and sign. Then scan its response here.')
		} else throw new Error('This page only supports saved Ledger and AirGap wallets')
	})
	if (record === undefined) return <main style = 'padding: 24px; color: var(--text-color);'><p>{ status }</p><p role = 'alert'>{ error }</p></main>
	const transaction = record.input.method === 'eth_sendTransaction' ? parseTransaction(ensureHex(record.input.data)) : undefined
	return <main style = 'max-width: 820px; margin: 24px auto; padding: 24px; overflow-wrap: anywhere; color: var(--text-color); display: flex; flex-direction: column; gap: 16px;'>
		<h1 style = 'font-size: 1.5rem; font-weight: 600;'>Review and sign</h1>
		<dl><dt>Originating website</dt><dd>{ record.websiteOrigin }</dd><dt>Mode</dt><dd>Signing · real signature</dd><dt>Acting address</dt><dd>{ record.input.address }</dd><dt>Network chain ID</dt><dd>{ record.input.chainId.toString() }</dd><dt>Signing wallet</dt><dd>{ signingWalletDescription(record.binding) }</dd><dt>Status</dt><dd>{ record.phase }</dd></dl>
		<p>Interceptor’s simulated explanation is in the confirmation window. It is not a promise about execution or the information your signing device displays. Review the device’s own display independently.</p>
		{ transaction === undefined ? <pre style = 'white-space: pre-wrap;'>{ record.input.data }</pre> : <section>
			<p>To: { transaction.to ?? 'Contract creation' } · Value: { String(transaction.value) } attoeth</p>
			<p>Nonce: { String(transaction.nonce) } · Gas limit: { String(transaction.gas) }</p>
			<p>Maximum fee: { (BigInt(transaction.gas ?? 0) * (transaction.maxFeePerGas ?? 0n)).toString() } attoeth · Maximum priority fee per gas: { String(transaction.maxPriorityFeePerGas) } attoeth</p>
			<details><summary>Exact transaction data and access list</summary><pre style = 'white-space: pre-wrap;'>{ record.input.data }</pre></details>
			{ record.phase === 'review' || record.phase === 'signed' ? <details><summary>Edit fees and advanced nonce</summary>
				<label>Gas limit <input value = { gas } onInput = { (event) => setGas(event.currentTarget.value) }/></label>
				<label>Max fee per gas (attoeth) <input value = { maxFee } onInput = { (event) => setMaxFee(event.currentTarget.value) }/></label>
				<label>Max priority fee per gas (attoeth) <input value = { priority } onInput = { (event) => setPriority(event.currentTarget.value) }/></label>
				<label>Nonce (advanced) <input value = { nonce } onInput = { (event) => setNonce(event.currentTarget.value) }/></label>
				<p>Changing any signed field invalidates the signature and requires a new review and device approval.</p>
				<button class = 'button' disabled = { busy } onClick = { () => run(async () => { await command({ method: 'signing_editFees', id, revision: record.revision, nonce: BigInt(nonce), gas: BigInt(gas), maxFeePerGas: BigInt(maxFee), maxPriorityFeePerGas: BigInt(priority) }); setQr(undefined); setStatus('Fields changed. Review the new exact payload before approving again.') }) }>Apply changes and review again</button>
			</details> : undefined }
		</section> }
		{ record.phase === 'review' ? <button class = 'button' onClick = { () => run(async () => { await openSigningWalletSetup(record.binding.wallet.address); setStatus('Changing this address’s signing wallet invalidates this request. Cancel and review a new application request after saving.') }) }>Change signing wallet</button> : undefined }
		<p role = 'status'>{ status }</p>{ error === undefined ? undefined : <p role = 'alert'>{ error }</p> }
		{ record.phase === 'review' || record.phase === 'approved' ? <button class = 'button is-primary' disabled = { busy } onClick = { sign }>{ record.phase === 'approved' ? 'Resume with ' : 'Approve and continue with ' }{ record.binding.wallet.type === 'ledger' ? 'Ledger' : 'AirGap Vault' }</button> : undefined }
		{ qr === undefined || record.phase !== 'approved' ? undefined : <section><AnimatedSigningQr payload = { qr }/><button class = 'button' onClick = { () => { decoder.current = createAirGapUrDecoder('eth-signature'); setScanning(true) } }>Scan signed response</button></section> }
		{ scanning && record.phase === 'approved' ? <SigningQrScanner onFrame = { async (frame) => {
			const decoded = decoder.current.receive(frame)
			if (decoded.payload === undefined) { setStatus(`Received ${ decoded.received } of ${ decoded.total } fragments`); return false }
			setStatus('Verifying signature…')
			const result = await verifyAirGapSigningResponse(decoded.payload, record.revision, prepareDirectPayload(record.input))
			await command({ method: 'signing_result', id, revision: record.revision, result })
			setScanning(false); setQr(undefined); setStatus(transaction === undefined ? 'Signature verified and returned to the originating application.' : 'Signature verified. Confirm broadcast below.')
			return true
		} }/> : undefined }
		{ transaction !== undefined && ['signed', 'submitting', 'submitted', 'confirmed'].includes(record.phase) ? <button class = 'button is-primary' disabled = { busy } onClick = { () => run(async () => { const next = await command({ method: 'signing_broadcast', id, revision: record.revision }); setStatus(next.phase === 'confirmed' ? next.executionSucceeded ? 'Transaction confirmed on the configured RPC.' : 'Transaction confirmed but execution reverted.' : 'Transaction submitted. Its hash was returned to the originating application.') }) }>{ record.phase === 'signed' ? 'Broadcast transaction' : 'Reconcile transaction by hash' }</button> : undefined }
		{ record.transactionHash === undefined ? undefined : <p>Transaction hash: { record.transactionHash }</p> }
		{ ['review', 'approved', 'signed'].includes(record.phase) ? <button class = 'button' onClick = { () => { controller.current.abort(new Error('Signing cancelled')); void run(async () => { await command({ method: 'signing_cancel', id }); setScanning(false); setQr(undefined); setStatus('Request cancelled.') }) } }>Cancel request</button> : undefined }
	</main>
}
render(<DirectSigningPage/>, document.body)
