import * as funtypes from 'funtypes'

export type WebsiteMetadataInfo  = funtypes.Static<typeof WebsiteMetadataInfo>
export const WebsiteMetadataInfo = funtypes.Intersect(
	funtypes.ReadonlyObject({
		name: funtypes.String,
	}),
	funtypes.Partial({
		message: funtypes.Union(funtypes.Undefined, funtypes.String),
		externalRpc: funtypes.Boolean,
		usesSubGraph: funtypes.Boolean,
		suggestedAlternative: funtypes.Union(funtypes.Undefined, funtypes.String),
	})
)

export type WebsiteMetaData  = funtypes.Static<typeof WebsiteMetaData>
export const WebsiteMetaData = funtypes.ReadonlyRecord(funtypes.String, WebsiteMetadataInfo)

export const getWebsiteWarningMessage = (websiteOrigin: string): { message: string, suggestedAlternative: string | undefined } | undefined => {
	const data = websiteMetaData[websiteOrigin]
	if (data === undefined) return undefined
	if (data.message !== undefined) return { message: data.message, suggestedAlternative: data.suggestedAlternative }
	if (data.externalRpc) return { message: `${ data.name } connects to external centralized RPC and thus simulation mode does not work properly on this application.`, suggestedAlternative: data.suggestedAlternative }
	if (data.usesSubGraph) return { message: `${ data.name } connects to centralized sub graph node and thus simulation mode does not work properly on this application.`, suggestedAlternative: data.suggestedAlternative }
	return undefined
}

const websiteMetaData: WebsiteMetaData = {
	'app.uniswap.org': {
		name: 'Uniswap',
		message: `Uniswap v4 does not work properly on The Interceptor as Uniswap V4 uses centralized components. Uniswap V4 interface also charges an extra charge for it's users. It's recommended to use another interface without these limitations.`,
		suggestedAlternative: 'https://bafybeib2jsrxvqwm4hscnwtp5pcd2gpxdaltk745hffsnktb2sa3humm4i.ipfs.dweb.link',
		externalRpc: true,
	},
	'octant.app': {
		name: 'Octant',
		externalRpc: true,
	},
	'app.aave.com/': {
		name: 'Aave',
		externalRpc: true,
	},
	'app.compound.finance': {
		name: 'Compound',
		externalRpc: true,
	},
	'curve.fi': {
		name: 'Curve',
		usesSubGraph: true,
	},
	'app.balancer.fi': {
		name: 'Balancer',
		externalRpc: true,
	},
	'app.spark.fi': {
		name: 'Spark',
		externalRpc: true,
	},
	'kwenta.eth.limo': {
		name: 'Kwenta',
		externalRpc: true,
	}
}
