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

export const getWebsiteWarningMessage = (websiteOrigin: string, simulationMode: boolean): { message: string, suggestedAlternative: string | undefined } | undefined => {
	const data = websiteMetaData[websiteOrigin]
	if (data === undefined) return undefined
	if (data.message !== undefined) return { message: data.message, suggestedAlternative: data.suggestedAlternative }
	if (simulationMode === false) return undefined
	if (data.externalRpc) return { message: `${ data.name } relies on an external centralized RPC connection, resulting in the improper functioning of simulation mode within this application.`, suggestedAlternative: data.suggestedAlternative }
	if (data.usesSubGraph) return { message: `${ data.name } relies on an external centralized Sub Graph connection, resulting in the improper functioning of simulation mode within this application`, suggestedAlternative: data.suggestedAlternative }
	return undefined
}

const websiteMetaData: WebsiteMetaData = {
	'app.uniswap.org': {
		name: 'Uniswap',
		message: `Uniswap V4 encounters functionality issues when using The Interceptor in Simulation Mode due to its reliance on centralized components. Additionally, the Uniswap V4 interface imposes an extra fee on its users. It is advisable to use alternative interface that does not have these limitations.`,
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
	},
	'opensea.io': {
		name: 'OpenSea',
		externalRpc: true,
	},
	'blur.io': {
		name: 'Blur',
		externalRpc: true,
	}
}
