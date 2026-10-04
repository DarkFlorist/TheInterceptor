import { getHostWithPort, getTabIfExists } from '../../utils/requests.js'
import { openSigningWalletSetup } from '../../components/subcomponents/SigningWalletSummary.js'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { DirectSigningRecord, DirectSigningRequest } from '../../types/directSigning.js'
import { sendSigningPageRequest } from '../../utils/signingPageMessages.js'
import { prepareDirectPayload } from '../../signing/backend.js'
import { selectLedgerDevice, withLedgerDevice } from '../../signing/ledgerHid.js'
import { signWithLedger } from '../../signing/ledgerEthereum.js'
import { encodeAirGapSigningRequest, verifyAirGapSigningResponse } from '../../signing/airgapEthereum.js'
import { createAirGapUrDecoder } from '../../signing/airgapUr.js'
import { ensureHex } from '../../utils/ethereumBytes.js'
import { parseTransaction } from '../../utils/ethereumTransactions.js'

export function useDirectSigning() {
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
			const next = reply.record
			setRecord(next)
			return next
		} catch (failure) {
			// A command can persist a new phase before its RPC or application reply fails.
			if (request.method !== 'signing_get') {
				const recovered = (await sendSigningPageRequest({ method: 'signing_get', id })).record
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
				const current = (await sendSigningPageRequest({ method: 'signing_get', id })).record
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
	const resetResponseScan = () => { decoder.current = createAirGapUrDecoder('eth-signature'); setStatus('Waiting for the response QR from Vault.') }
	return { record, error, status, busy, qr, scanning, nonce, setNonce, gas, setGas, maxFee, setMaxFee, priority, setPriority, errorPanel, sign, changeSigningWallet, applyFeeChanges, startResponseScan, broadcastTransaction, returnToApplication, cancelRequest, receiveSignedResponse, setStatus, resetResponseScan }
}
