import { directSigningProgress } from './signing/signingProgress.js'
import { SigningCopyValue } from './components/subcomponents/SigningCopyValue.js'
import { TypedDataFields } from './components/subcomponents/TypedDataFields.js'
import { parseDirectSigningTypedData } from './signing/exactPayload.js'
import { LedgerScreenPreview } from './components/subcomponents/LedgerScreenPreview.js'
import { SigningSteps } from './components/subcomponents/SigningSteps.js'
import { formatUnits } from './utils/ethereumUnits.js'
import { CHAIN_NAMES } from './utils/chainNames.js'
import { render } from 'preact'
import { prepareDirectPayload, signingWalletDescription } from './signing/backend.js'
import { AnimatedSigningQr, SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { bytesFromHex, ensureHex } from './utils/ethereumBytes.js'
import { parseTransaction } from './utils/ethereumTransactions.js'

import { useDirectSigning } from './components/hooks/useDirectSigning.js'

function DirectSigningPage() {
	const { record, error, status, busy, qr, scanning, nonce, setNonce, gas, setGas, maxFee, setMaxFee, priority, setPriority, errorPanel, sign, changeSigningWallet, applyFeeChanges, startResponseScan, broadcastTransaction, returnToApplication, cancelRequest, receiveSignedResponse, setStatus, resetResponseScan } = useDirectSigning()
	if (record === undefined) return <main style = 'padding: 24px; color: var(--text-color);'><p>{ status }</p><p ref = { errorPanel } tabIndex = { -1 } role = 'alert'>{ error }</p></main>
	const transaction = record.input.method === 'eth_sendTransaction' ? parseTransaction(ensureHex(record.input.data)) : undefined
	const walletName = record.binding.wallet.type === 'ledger' ? 'Ledger' : 'AirGap Vault'
	const signed = record.phase === 'signed'
	const messageBytes = record.input.method === 'personal_sign' ? bytesFromHex(ensureHex(record.input.data)) : undefined
	const messageText = messageBytes === undefined ? undefined : new TextDecoder().decode(messageBytes)
	const typedData = record.input.method === 'eth_signTypedData_v4' ? parseDirectSigningTypedData(record.input.data) : undefined
	const complete = record.phase === 'confirmed' || signed && transaction === undefined
	const completedTitle = record.phase === 'cancelled' ? 'Request cancelled' : record.phase === 'confirmed' ? record.executionSucceeded ? 'Transaction confirmed' : 'Transaction reverted' : record.phase === 'submitted' ? 'Transaction submitted' : record.phase === 'submitting' ? 'Checking transaction submission' : undefined
	return <main class = 'signing-page'>
		<header><p class = 'signing-muted'>Signing mode · real signature</p><h1>{ completedTitle ?? (signed ? transaction === undefined ? 'Message signature verified' : 'Ready to broadcast' : scanning ? 'Scan the signed response' : qr !== undefined ? 'Sign offline with AirGap Vault' : 'Review and sign') }</h1></header>
		<SigningSteps steps = { transaction === undefined ? ['Review', 'Sign', 'Return signature'] : ['Review', 'Sign', 'Broadcast'] } { ...directSigningProgress(record.phase, transaction !== undefined) }/>
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
			{ scanning ? <><SigningQrScanner onFrame = { receiveSignedResponse } onError = { () => setStatus('Scan stopped.') } onStart = { resetResponseScan }/><p class = 'signing-muted'>{ status }</p></> : undefined }
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
