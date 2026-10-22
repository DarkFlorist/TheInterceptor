import { isUuid } from './uuid.js'
import type { EIP6963ProviderInfo } from '../types/signerTypes.js'
export type { EIP6963ProviderInfo } from '../types/signerTypes.js'
import { internalSignerStatuses } from './signerIdentity.js'

const isValidImageDataUri = (value: string) => {
	const match = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]+)*(;base64)?,(.+)$/is.exec(value)
	if (match === null) return false
	const payload = match[2]
	if (payload === undefined) return false
	if (match[1] === ';base64') return /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=|[a-z0-9+/]{2}|[a-z0-9+/]{3})?$/i.test(payload)
	try {
		return decodeURIComponent(payload).length > 0
	} catch (error: unknown) {
		if (error instanceof URIError) return false
		throw error
	}
}
export const isEip6963ProviderUuid = (value: string) => isUuid(value) && value[14] === '4'
export const isEip6963ProviderName = (value: string) => value.length > 0 && value.length <= 128 && !internalSignerStatuses.has(value)
export const isEip6963ProviderIcon = (value: string) => value.length <= 131_072 && isValidImageDataUri(value)
export const isEip6963ProviderRdns = (value: string) => value.length > 0 && value.length <= 255 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)

export const isEip6963ProviderInfo = (value: unknown): value is EIP6963ProviderInfo => typeof value === 'object' && value !== null
	&& 'uuid' in value && typeof value.uuid === 'string' && isEip6963ProviderUuid(value.uuid)
	&& 'name' in value && typeof value.name === 'string' && isEip6963ProviderName(value.name)
	&& 'icon' in value && typeof value.icon === 'string' && isEip6963ProviderIcon(value.icon)
	&& 'rdns' in value && typeof value.rdns === 'string' && isEip6963ProviderRdns(value.rdns)
