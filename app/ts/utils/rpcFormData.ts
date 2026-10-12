import { RpcEntry } from '../types/rpc.js'

// The edit form's URL field is read-only, redacted, and unnamed, so edits pass the stored URL here instead of submitting the field text.
export function parseRpcFormData(formData: FormData, editedEntryRpcUrl?: string) {
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
	return RpcEntry.safeParse(newRpcEntry)
}
