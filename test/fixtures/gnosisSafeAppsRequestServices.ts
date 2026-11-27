import type { GnosisSafeAppsRequestServices } from '../../app/ts/background/gnosisSafeAppsRequestPolicy.js'

type SigningServices = Extract<GnosisSafeAppsRequestServices, { mode: 'signing' }>

const unexpectedGatewayCall = async (): Promise<never> => { throw new Error('Unexpected Gnosis Safe gateway call in this policy test') }

// Policy-only tests must opt into signing explicitly; each gateway test supplies the services it exercises.
export const createGnosisSafeAppsSigningServices = (overrides: Partial<Omit<SigningServices, 'mode'>> = {}): SigningServices => ({
	mode: 'signing',
	messages: { submit: unexpectedGatewayCall, getSignature: unexpectedGatewayCall },
	getBalances: unexpectedGatewayCall,
	getTransaction: unexpectedGatewayCall,
	...overrides,
})
