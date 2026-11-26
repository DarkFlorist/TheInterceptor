// Account connection is one policy shared by the background gate and classic provider handshake.
export const ACCOUNT_CONNECTION_METHODS = ['eth_requestAccounts', 'wallet_requestPermissions'] as const
const accountConnectionMethods: ReadonlySet<string> = new Set(ACCOUNT_CONNECTION_METHODS)

export const isAccountConnectionMethod = (method: string) => accountConnectionMethods.has(method)
