const OWNER_ADDRESS = '0x5d46ac553a974ef992a08eeef0a05990802f01f6'
globalThis.__sealwortFixtureLoaded = true

const accountOutput = document.querySelector('#account')
const statusOutput = document.querySelector('#status')
const connectButton = document.querySelector('#connect')
const fileInput = document.querySelector('.file-input')
const verifyButton = document.querySelector('#verify')
const signButton = document.querySelector('#sign')
const downloadButton = document.querySelector('#download')

let stackExport

const address = (value) => `0x${ BigInt(value).toString(16).padStart(40, '0') }`
const decimal = (value) => BigInt(value).toString()

function toSafeTypedData(safeTx) {
	return JSON.stringify({
		types: safeTx.types,
		primaryType: safeTx.primaryType,
		domain: {
			chainId: decimal(safeTx.domain.chainId),
			verifyingContract: address(safeTx.domain.verifyingContract),
		},
		message: {
			to: address(safeTx.message.to),
			value: decimal(safeTx.message.value),
			data: safeTx.message.data,
			operation: decimal(safeTx.message.operation),
			safeTxGas: decimal(safeTx.message.safeTxGas),
			baseGas: decimal(safeTx.message.baseGas),
			gasPrice: decimal(safeTx.message.gasPrice),
			gasToken: address(safeTx.message.gasToken),
			refundReceiver: address(safeTx.message.refundReceiver),
			nonce: decimal(safeTx.message.nonce),
		},
	})
}

async function connect() {
	try {
		const [account] = await globalThis.ethereum.request({ method: 'eth_requestAccounts' })
		accountOutput.textContent = account
		const expectedState = await fetch('./expected-safe-state.json').then((response) => response.json())
		const chainId = await globalThis.ethereum.request({ method: 'eth_chainId' })
		await globalThis.ethereum.request({ method: 'wallet_getCapabilities', params: [account, [chainId]] })
		const code = await globalThis.ethereum.request({ method: 'eth_getCode', params: [account, 'latest'] })
		if (code === '0x') throw new Error('The connected account is not a contract')
		const [singletonStorage, ...safeCallResults] = await Promise.all([
			globalThis.ethereum.request({ method: 'eth_getStorageAt', params: [account, '0x0', 'latest'] }),
			...expectedState.calls.map(({ data }) => globalThis.ethereum.request({
				method: 'eth_call',
				params: [{ to: account, data }, 'latest'],
			})),
		])
		if (singletonStorage !== expectedState.singletonStorage) throw new Error('Unexpected Safe singleton storage')
		for (const [index, result] of safeCallResults.entries()) {
			if (result !== expectedState.calls[index]?.result) throw new Error('Unexpected Safe state response')
		}
		const singletonCode = await globalThis.ethereum.request({ method: 'eth_getCode', params: [expectedState.singletonAddress, 'latest'] })
		if (singletonCode === '0x') throw new Error('The Safe singleton has no code')
		statusOutput.textContent = 'Safe account inspection complete.'
	} catch (error) {
		statusOutput.textContent = error instanceof Error ? error.message : String(error)
	}
}

async function importSelectedFile() {
	const file = fileInput.files?.[0]
	if (file === undefined) return
	stackExport = JSON.parse(await file.text())
	verifyButton.disabled = false
	statusOutput.textContent = 'Verify the transactions against current on-chain state before signing.'
}

async function verify() {
	const stack = stackExport.stacks[0]
	const expectedState = await fetch('./expected-safe-state.json').then((response) => response.json())
	const chainId = await globalThis.ethereum.request({ method: 'eth_chainId' })
	if (chainId !== expectedState.chainId) throw new Error(`Expected chain ${ expectedState.chainId }, received ${ chainId }`)
	for (const { data, result: expectedResult } of expectedState.calls) {
		const result = await globalThis.ethereum.request({
			method: 'eth_call',
			params: [{ to: address(stack.safeAddress), data }, 'latest'],
		})
		if (result !== expectedResult) throw new Error(`Unexpected Safe response for ${ data }`)
	}
	signButton.disabled = false
	statusOutput.textContent = 'Verified 1 Safe transaction(s) against current on-chain state.'
}

async function sign() {
	const stack = stackExport.stacks[0]
	const transaction = stack.transactions[0]
	const signature = await globalThis.ethereum.request({
		method: 'eth_signTypedData_v4',
		params: [address(stack.safeAddress), toSafeTypedData(transaction.safeTx)],
	})
	transaction.signatures.push({ signer: OWNER_ADDRESS, signature })
	signButton.disabled = true
	signButton.textContent = 'Signature added'
	downloadButton.disabled = false
	statusOutput.textContent = `Signature from ${ OWNER_ADDRESS }`
}

function download() {
	const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(stackExport, undefined, '\t')], { type: 'application/json' }))
	const link = document.createElement('a')
	link.href = objectUrl
	link.download = 'interceptor-safe-stack.json'
	link.click()
	URL.revokeObjectURL(objectUrl)
	statusOutput.textContent = 'Updated Safe stack downloaded.'
}

connectButton.addEventListener('click', connect)
fileInput.addEventListener('change', importSelectedFile)
verifyButton.addEventListener('click', verify)
signButton.addEventListener('click', sign)
downloadButton.addEventListener('click', download)
globalThis.__sealwortFixture = { connect, importSelectedFile, verify, sign, download }
