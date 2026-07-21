import * as funtypes from 'funtypes'

export type SignerName = funtypes.Static<typeof SignerName>
export const SignerName = funtypes.Union(
	funtypes.Literal('NoSigner'),
	funtypes.Literal('NotRecognizedSigner'),
	funtypes.Literal('MetaMask'),
	funtypes.Literal('Ambire'),
	funtypes.Literal('Brave'),
	funtypes.Literal('CoinbaseWallet'),
	funtypes.Literal('Rabby'),
	funtypes.Literal('NoSignerDetected'),
)
