import type { Result } from 'funtypes'
import { RpcEntry } from '../types/rpc.js'
import { getRpcUrlCredentialsTransportError } from './rpcUrlCredentials.js'

// The edit form's URL field is read-only, redacted, and unnamed, so edits pass the stored URL here instead of submitting the field text.
export function parseRpcFormData(formData: FormData, editedEntryRpcUrl?: string): Result<RpcEntry> {
	const chainIdFromForm = formData.get('chainId')?.toString().trim()
	const blockExplorerUrlForm = formData.get('blockExplorerUrl')?.toString().trim()
	const blockExplorerApiKeyForm = formData.get('blockExplorerApiKey')?.toString().trim()
	const hasBlockExplorerUrl = blockExplorerUrlForm !== undefined && blockExplorerUrlForm.length > 0
	const newRpcEntry = {
		name: formData.get('name')?.toString().trim() || '',
		chainId: chainIdFromForm ? `0x${ BigInt(chainIdFromForm).toString(16) }` : '',
		httpsRpc: editedEntryRpcUrl ?? (formData.get('httpsRpc')?.toString().trim() || ''),
		currencyName: formData.get('currencyName')?.toString().trim() || '',
		currencyTicker: formData.get('currencyTicker')?.toString().trim() || '',
		...hasBlockExplorerUrl ? { blockExplorer: { apiUrl: blockExplorerUrlForm, apiKey: blockExplorerApiKeyForm ?? '' } } : {},
		minimized: true,
		primary: false,
	}
	// Checked first because the RPC probe also fails for this URL and leaves the chain ID empty, so this is the actionable error.
	const credentialsTransportError = getRpcUrlCredentialsTransportError(newRpcEntry.httpsRpc)
	if (credentialsTransportError !== undefined) return { success: false, message: credentialsTransportError }
	return RpcEntry.safeParse(newRpcEntry)
}
