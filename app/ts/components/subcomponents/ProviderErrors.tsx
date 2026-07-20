import type { Signal } from '@preact/signals'
import type { TabState } from '../../types/user-interface-types.js'
import { METAMASK_ERROR_ALREADY_PENDING, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { isSignerMissing } from '../../utils/signerMetadata.js'
import { ErrorComponent } from './Error.js'
import { SignersLogoName } from './signers.js'

type ProviderErrorsParam = {
	tabState: Signal<TabState | undefined>
}

export function ProviderErrors({ tabState }: ProviderErrorsParam) {
	if (tabState.value === undefined || tabState.value.signerAccountError === undefined || isSignerMissing(tabState.value.signerName)) return <></>
	if (tabState.value.signerAccountError.code === METAMASK_ERROR_USER_REJECTED_REQUEST) return <ErrorComponent warning = { true } text = { <>Could not get an account from <SignersLogoName signerName = { tabState.value.signerName } /> as user denied the request.</> }/>
	if (tabState.value.signerAccountError.code === METAMASK_ERROR_ALREADY_PENDING.error.code) return <ErrorComponent warning = { true } text = { <>There's a connection request pending on <SignersLogoName signerName = { tabState.value.signerName } />. Please review the request.</> }/>
	return <ErrorComponent warning = { true } text = { <><SignersLogoName signerName = { tabState.value.signerName } /> returned error: "{ tabState.value.signerAccountError.message }".</> }/>
}
