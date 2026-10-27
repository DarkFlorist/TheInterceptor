import type { Result } from 'funtypes'
import { RpcEntry } from '../types/rpc.js'
import { getRpcUrlCredentialsTransportError } from './rpcUrlCredentials.js'

// The RPC form's one add-or-edit decision, made by getRpcFormMode and used both to render the URL field and to choose the saved URL. Adding saves the URL typed into the `httpsRpc` field. Editing saves the stored URL, because the form only shows it redacted in a read-only field without a form name.
export type RpcFormMode = { readonly kind: 'add' } | { readonly kind: 'edit', readonly storedRpcUrl: string }

export const getRpcFormMode = (editedEntry: RpcEntry | undefined): RpcFormMode => editedEntry === undefined ? { kind: 'add' } : { kind: 'edit', storedRpcUrl: editedEntry.httpsRpc }

export function parseRpcFormData(formData: FormData, formMode: RpcFormMode): Result<RpcEntry> {
	const chainIdFromForm = formData.get('chainId')?.toString().trim()
	const blockExplorerUrlForm = formData.get('blockExplorerUrl')?.toString().trim()
	const blockExplorerApiKeyForm = formData.get('blockExplorerApiKey')?.toString().trim()
	const hasBlockExplorerUrl = blockExplorerUrlForm !== undefined && blockExplorerUrlForm.length > 0
	const newRpcEntry = {
		name: formData.get('name')?.toString().trim() || '',
		chainId: chainIdFromForm ? `0x${ BigInt(chainIdFromForm).toString(16) }` : '',
		httpsRpc: formMode.kind === 'edit' ? formMode.storedRpcUrl : formData.get('httpsRpc')?.toString().trim() || '',
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
