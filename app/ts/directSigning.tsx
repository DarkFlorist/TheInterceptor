import { SigningCopyValue } from './components/subcomponents/SigningCopyValue.js'
import { getHostWithPort, getTabIfExists } from './utils/requests.js'
import { TypedDataFields } from './components/subcomponents/TypedDataFields.js'
import { parseDirectSigningTypedData } from './signing/exactPayload.js'
import { LedgerScreenPreview } from './components/subcomponents/LedgerScreenPreview.js'
import { SigningSteps } from './components/subcomponents/SigningSteps.js'
import { formatUnits } from './utils/ethereumUnits.js'
import { CHAIN_NAMES } from './utils/chainNames.js'
import { openSigningWalletSetup } from './components/subcomponents/SigningWalletSummary.js'
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { DirectSigningRecord, type DirectSigningRequest } from './types/directSigning.js'
import { sendSigningPageRequest } from './signing/pageMessages.js'
import { prepareDirectPayload, signingWalletDescription } from './signing/backend.js'
import { selectLedgerDevice, withLedgerDevice } from './signing/ledgerHid.js'
import { signWithLedger } from './signing/ledgerEthereum.js'
import { encodeAirGapSigningRequest, verifyAirGapSigningResponse } from './signing/airgapEthereum.js'
import { createAirGapUrDecoder } from './signing/airgapUr.js'
import { AnimatedSigningQr, SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { bytesFromHex, ensureHex } from './utils/ethereumBytes.js'
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
	const errorPanel = useRef<HTMLParagraphElement>(null)
	useEffect(() => { if (error !== undefined) errorPanel.current?.focus() }, [error])
	const controller = useRef(new AbortController())
	const decoder = useRef(createAirGapUrDecoder('eth-signature'))
	const command = async (request: DirectSigningRequest) => {
		try {
			const reply = await sendSigningPageRequest(request)
			const next = DirectSigningRecord.parse(reply.record)
			setRecord(next)
			return next
		} catch (failure) {
			// A command can persist a new phase before its RPC or application reply fails.
			if (request.method !== 'signing_get') {
				const recovered = DirectSigningRecord.parse((await sendSigningPageRequest({ method: 'signing_get', id })).record)
				setRecord(recovered)
				setStatus(recovered.phase === 'submitting' ? 'Submission outcome is uncertain. Reconcile by hash before taking further action.' : `Current request status: ${ recovered.phase }.`)
			}
			throw failure
		}
	}
	const run = async (operation: () => Promise<void>) => {
		setBusy(true)
		setError(undefined)
		try {
			await operation()
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Signing failed')
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => {
		void run(async () => {
			const next = await command({ method: 'signing_get', id })
			if (next.input.method === 'eth_sendTransaction') {
				const transaction = parseTransaction(ensureHex(next.input.data))
				setNonce(String(transaction.nonce)); setGas(String(transaction.gas)); setMaxFee(String(transaction.maxFeePerGas)); setPriority(String(transaction.maxPriorityFeePerGas))
			}
			if (next.phase === 'review') setStatus('Review the exact payload before approving.')
			else if (next.phase === 'approved') setStatus('Approval recovered. Resume this exact request or cancel it.')
			else if (next.phase === 'signed') setStatus(next.input.method === 'eth_sendTransaction'
				? 'Signature recovered. Review the transaction before broadcasting.'
				: 'Message signature recovered and returned to the originating application.')
			else setStatus(`Recovered request status: ${ next.phase }.`)
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
	const changeSigningWallet = () => run(async () => {
		if (record === undefined) return
		await openSigningWalletSetup(record.binding.wallet.address)
		setStatus('Changing this address’s signing wallet invalidates this request. Cancel and review a new application request after saving.')
	})
	const applyFeeChanges = () => run(async () => {
		if (record === undefined) return
		await command({
			method: 'signing_editFees', id, revision: record.revision,
			nonce: BigInt(nonce), gas: BigInt(gas),
			maxFeePerGas: BigInt(maxFee), maxPriorityFeePerGas: BigInt(priority),
		})
		setQr(undefined)
		setStatus('Fields changed. Review the new exact payload before approving again.')
	})
	const startResponseScan = () => {
		decoder.current = createAirGapUrDecoder('eth-signature')
		setScanning(true)
		setStatus('Waiting for the response QR from Vault.')
	}
	const broadcastTransaction = () => run(async () => {
		if (record === undefined) return
		const next = await command({ method: 'signing_broadcast', id, revision: record.revision })
		if (next.phase === 'confirmed') {
			setStatus(next.executionSucceeded ? 'Transaction confirmed on the configured RPC.' : 'Transaction confirmed but execution reverted.')
		} else {
			setStatus('Transaction submitted. Its hash was returned to the originating application.')
		}
	})
	const returnToApplication = () => run(async () => {
		if (record === undefined) return
		const tab = await getTabIfExists(record.request.requestSocket.tabId)
		// Website identities use host and port, matching access management.
		if (tab === undefined || tab.id === undefined || tab.windowId === undefined || tab.url === undefined || getHostWithPort(tab.url) !== record.websiteOrigin) throw new Error('The originating application is no longer open in its original tab.')
		await browser.tabs.update(tab.id, { active: true })
		await browser.windows.update(tab.windowId, { focused: true })
	})
	const cancelRequest = () => {
		controller.current.abort(new Error('Signing cancelled'))
		void run(async () => {
			await command({ method: 'signing_cancel', id })
			setScanning(false)
			setQr(undefined)
			setStatus('Request cancelled.')
		})
	}
	const receiveSignedResponse = async (frame: string) => {
		if (record === undefined) throw new Error('Signing request has not loaded')
		const decoded = decoder.current.receive(frame)
		if (decoded.payload === undefined) {
			setStatus(`Received ${ decoded.received } of ${ decoded.total } fragments`)
			return false
		}
		setStatus('Verifying signature…')
		const result = await verifyAirGapSigningResponse(decoded.payload, record.revision, prepareDirectPayload(record.input))
		await command({ method: 'signing_result', id, revision: record.revision, result })
		setScanning(false)
		setQr(undefined)
		setStatus(record.input.method !== 'eth_sendTransaction' ? 'Signature verified and returned to the originating application.' : 'Signature verified. Confirm broadcast below.')
		return true
	}
	if (record === undefined) return <main style = 'padding: 24px; color: var(--text-color);'><p>{ status }</p><p ref = { errorPanel } tabIndex = { -1 } role = 'alert'>{ error }</p></main>
	const transaction = record.input.method === 'eth_sendTransaction' ? parseTransaction(ensureHex(record.input.data)) : undefined
	const walletName = record.binding.wallet.type === 'ledger' ? 'Ledger' : 'AirGap Vault'
	const signed = record.phase === 'signed'
	const messageBytes = record.input.method === 'personal_sign' ? bytesFromHex(ensureHex(record.input.data)) : undefined
	const messageText = messageBytes === undefined ? undefined : new TextDecoder().decode(messageBytes)
	const typedData = record.input.method === 'eth_signTypedData_v4' ? parseDirectSigningTypedData(record.input.data) : undefined
	const step = record.phase === 'cancelled' ? -1 : record.phase === 'review' ? 0 : record.phase === 'approved' ? 1 : (record.phase === 'signed' || record.phase === 'submitting') && transaction !== undefined ? 2 : 3
	const complete = record.phase === 'confirmed' || signed && transaction === undefined
	const completedTitle = record.phase === 'cancelled' ? 'Request cancelled' : record.phase === 'confirmed' ? record.executionSucceeded ? 'Transaction confirmed' : 'Transaction reverted' : record.phase === 'submitted' ? 'Transaction submitted' : record.phase === 'submitting' ? 'Checking transaction submission' : undefined
	return <main class = 'signing-page'>
		<header><p class = 'signing-muted'>Signing mode · real signature</p><h1>{ completedTitle ?? (signed ? transaction === undefined ? 'Message signature verified' : 'Ready to broadcast' : scanning ? 'Scan the signed response' : qr !== undefined ? 'Sign offline with AirGap Vault' : 'Review and sign') }</h1></header>
		<SigningSteps steps = { transaction === undefined ? ['Review', 'Sign', 'Return signature'] : ['Review', 'Sign', 'Broadcast'] } current = { step }/>
		<section class = 'signing-panel signing-context'>
			<dl class = 'signing-grid'>
				<div><dt>Originating website</dt><dd>{ record.websiteOrigin }</dd></div>
				<div><dt>Network</dt><dd>{ CHAIN_NAMES.get(record.input.chainId.toString()) ?? 'Custom network' } <span class = 'signing-muted'>· Chain { record.input.chainId.toString() }</span></dd></div>
				<div><dt>Acting address</dt><dd><SigningCopyValue value = { record.input.address } label = 'acting address'/></dd></div>
				<div><dt>Signing wallet</dt><dd>{ signingWalletDescription(record.binding) }</dd></div>
			</dl>
			{ record.phase === 'review' ? <div class = 'signing-actions'><button class = 'button signing-secondary is-small' disabled = { busy } onClick = { changeSigningWallet }>Change signing wallet</button></div> : undefined }
		</section>
		{ transaction === undefined ? <section class = 'signing-panel'><h2>{ record.input.method === 'personal_sign' ? complete ? 'Signed personal message' : 'Personal message to sign' : complete ? 'Signed typed data (EIP-712)' : 'Typed data to sign (EIP-712)' }</h2>{ typedData === undefined ? <pre>{ messageText }</pre> : <><h3>Domain</h3><TypedDataFields fields = { typedData.domain }/><h3>{ typedData.primaryType }</h3><TypedDataFields fields = { typedData.message }/><details><summary>Full typed data and type definitions</summary><pre>{ JSON.stringify(JSON.parse(record.input.data), undefined, 2) }</pre></details></> }{ messageBytes === undefined ? undefined : <details><summary>Exact message bytes · { messageBytes.length } bytes</summary><p class = 'signing-muted'>Text is a UTF-8 preview. Binary bytes and invisible characters may not display as text; the exact bytes below are signed.</p><pre>{ record.input.data }</pre></details> }</section> : <section class = 'signing-panel'>
			<dl class = 'signing-grid'>
				<div><dt>Amount</dt><dd class = 'signing-amount'>{ formatUnits(transaction.value ?? 0n, 18) } ether</dd></div>
				<div><dt>Maximum network fee</dt><dd class = 'signing-amount'>{ formatUnits(BigInt(transaction.gas ?? 0) * (transaction.maxFeePerGas ?? 0n), 18) } ether</dd></div>
				<div><dt>Recipient</dt><dd>{ transaction.to === undefined ? 'Contract creation' : <SigningCopyValue value = { transaction.to } label = 'recipient address'/> }</dd></div>
				<div><dt>Fee per gas / priority fee</dt><dd>{ formatUnits(transaction.maxFeePerGas ?? 0n, 9) } / { formatUnits(transaction.maxPriorityFeePerGas ?? 0n, 9) } nanoeth</dd></div>
			</dl>
			<details><summary>Exact transaction data and access list</summary><p>Nonce: { String(transaction.nonce) } · Gas limit: { String(transaction.gas) }</p><h3>Call data</h3><pre>{ transaction.data ?? '0x' }</pre><h3>Access list</h3><pre>{ JSON.stringify(transaction.accessList ?? [], undefined, 2) }</pre><details><summary>Serialized unsigned transaction</summary><pre>{ record.input.data }</pre></details></details>
			{ record.phase === 'review' || signed ? <details><summary>Edit fees and advanced nonce</summary>
				<div class = 'signing-grid'>
					<label>Gas limit<input inputMode = 'numeric' value = { gas } onInput = { (event) => setGas(event.currentTarget.value) }/></label>
					<label>Max fee per gas (attoeth)<input inputMode = 'numeric' value = { maxFee } onInput = { (event) => setMaxFee(event.currentTarget.value) }/></label>
					<label>Max priority fee per gas (attoeth)<input inputMode = 'numeric' value = { priority } onInput = { (event) => setPriority(event.currentTarget.value) }/></label>
					<label>Nonce (advanced)<input inputMode = 'numeric' value = { nonce } onInput = { (event) => setNonce(event.currentTarget.value) }/></label>
				</div>
				<p class = 'signing-muted'>Changing a signed field requires a new review and signature.</p>
				<button class = 'button signing-secondary' disabled = { busy } onClick = { applyFeeChanges }>Apply changes and review again</button>
			</details> : undefined }
		</section> }
		{ record.binding.wallet.type === 'airgap' ? <details class = 'signing-support'><summary>AirGap compatibility</summary><p>Use Vault 3.34.4 or a compatible ERC-4527 Ethereum signer. EIP-1559 transactions, personal messages, and EIP-712 v4 are reference-tested. Account QR codes cannot report the Vault version or its signing capabilities; check the installed version on your offline device. Interceptor verifies every returned signature against this exact request.</p></details> : undefined }
		{ record.binding.wallet.type === 'ledger' && !complete ? <LedgerScreenPreview key = { record.revision } payload = { prepareDirectPayload(record.input) }/> : undefined }
		{ record.phase === 'review' ? <p class = 'signing-notice'>Review Interceptor’s simulated explanation in the confirmation window, then check your device’s own display. Simulation does not guarantee execution or what the device displays.</p> : undefined }
		{ record.phase === 'confirmed' ? <section class = { `signing-panel ${ record.executionSucceeded ? 'signing-success' : 'signing-error' }` }><h2>{ record.executionSucceeded ? 'Transaction confirmed' : 'Transaction reverted' }</h2><p>{ record.executionSucceeded ? 'The network confirmed your transaction. You can return to the application.' : 'The network included your transaction, but execution failed. Network fees may still apply.' }</p>{ record.transactionHash === undefined ? undefined : <SigningCopyValue value = { record.transactionHash } label = 'transaction hash'/> }</section> : undefined }
		{ signed ? <section class = 'signing-panel signing-success'><h2>{ transaction === undefined ? 'Signature verified · Returned to application' : 'Signature verified · Not broadcast' }</h2><p>{ transaction === undefined ? 'The message signature belongs to the expected account and payload.' : 'Check the recipient, amount, and maximum fee above. Broadcasting sends this signed transaction to the network.' }</p></section> : undefined }
		<p class = { qr !== undefined || complete ? 'signing-screen-reader' : 'signing-muted' } role = 'status' aria-atomic = 'true'>{ status }</p>
		{ error === undefined ? undefined : <p ref = { errorPanel } tabIndex = { -1 } class = 'signing-error' role = 'alert'>{ error }</p> }
		{ qr === undefined || record.phase !== 'approved' ? undefined : <section class = 'signing-panel'>
			{ scanning ? <><h2>Return the signature to Interceptor</h2><p>In Vault, finish signing and display the response QR. Enable this computer’s camera to scan it.</p><details><summary>Show outgoing request again</summary><AnimatedSigningQr payload = { qr }/></details></> : <><h2>Scan this request with Vault</h2><p>Review the request on your offline device and sign. Then bring its response back here.</p><AnimatedSigningQr payload = { qr }/><div class = 'signing-actions'><button class = 'button is-primary' onClick = { startResponseScan }>Scan signed response</button></div></> }
			{ scanning ? <><SigningQrScanner onFrame = { receiveSignedResponse } onError = { () => setStatus('Scan stopped.') } onStart = { () => { decoder.current = createAirGapUrDecoder('eth-signature'); setStatus('Waiting for the response QR from Vault.') } }/><p class = 'signing-muted'>{ status }</p></> : undefined }
		</section> }
		<div class = 'signing-actions'>
			{ complete ? <button class = 'button is-primary' disabled = { busy } onClick = { returnToApplication }>Return to application</button> : undefined }
			{ record.phase === 'review' || record.phase === 'approved' && qr === undefined ? <button class = 'button is-primary' disabled = { busy } onClick = { sign }>{ record.phase === 'approved' ? 'Resume with ' : 'Approve and continue with ' }{ walletName }</button> : undefined }
			{ transaction !== undefined && ['signed', 'submitting', 'submitted'].includes(record.phase) ? <button class = 'button is-primary' disabled = { busy } onClick = { broadcastTransaction }>{ signed ? 'Broadcast transaction' : 'Reconcile transaction by hash' }</button> : undefined }
			{ (record.phase === 'review' || record.phase === 'approved' || signed && transaction !== undefined) ? <button class = 'button signing-secondary' onClick = { cancelRequest }>Cancel request</button> : undefined }
		</div>
		{ record.transactionHash === undefined || complete ? undefined : <details><summary>Transaction hash</summary><SigningCopyValue value = { record.transactionHash } label = 'transaction hash'/></details> }
	</main>
}
render(<DirectSigningPage/>, document.body)
