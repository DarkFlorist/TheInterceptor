import * as funtypes from 'funtypes'
import { EthereumAddress } from './wire-types.js'

export type Website = funtypes.Static<typeof Website>
export const Website = funtypes.ReadonlyObject({
	websiteOrigin: funtypes.String,
	icon: funtypes.Union(funtypes.String, funtypes.Undefined),
	title: funtypes.Union(funtypes.String, funtypes.Undefined),
})

export type WebsiteAddressAccess = funtypes.Static<typeof WebsiteAddressAccess>
export const WebsiteAddressAccess = funtypes.ReadonlyObject({
	address: EthereumAddress,
	access: funtypes.Boolean,
}).asReadonly()

export type WebsiteAccess = funtypes.Static<typeof WebsiteAccess>
export const WebsiteAccess = funtypes.Intersect(
	funtypes.ReadonlyObject({
		website: Website,
		addressAccess: funtypes.Union(funtypes.ReadonlyArray(WebsiteAddressAccess), funtypes.Undefined),
	}),
	funtypes.ReadonlyPartial({
		access: funtypes.Boolean,
		interceptorDisabled: funtypes.Boolean,
		declarativeNetRequestBlockMode: funtypes.Union(funtypes.Literal('block-all'), funtypes.Literal('disabled'))
	})
)

export type WebsiteAccessArray = funtypes.Static<typeof WebsiteAccessArray>
export const WebsiteAccessArray = funtypes.ReadonlyArray(WebsiteAccess)

export type PopupOrTabId = funtypes.Static<typeof PopupOrTabId>
export const PopupOrTabId = funtypes.ReadonlyObject({
	id: funtypes.Number,
	type: funtypes.Union(funtypes.Literal('tab'), funtypes.Literal('popup'))
})
