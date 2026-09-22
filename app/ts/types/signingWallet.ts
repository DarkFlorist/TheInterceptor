import * as funtypes from 'funtypes'
import { addr } from 'micro-eth-signer'
import { EthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { bytesFromHex, ensureHex } from '../utils/ethereumBytes.js'
import { encodeLedgerDerivationPath } from '../signing/ledgerFraming.js'

const WalletLabel = funtypes.String.withConstraint((label) => label.trim().length > 0 && label.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(label))
const DerivationPath = funtypes.String.withConstraint((path) => {
	try { encodeLedgerDerivationPath(path); return true } catch { return false }
})
const PublicKey = funtypes.String.withConstraint((key) => /^0x(?:04[0-9a-f]{128}|0[23][0-9a-f]{64})$/iu.test(key))
const common = { address: EthereumAddress, label: WalletLabel }

export type SigningWallet = funtypes.Static<typeof SigningWallet>
export const SigningWallet = funtypes.Union(
	funtypes.ReadonlyObject({ ...common, type: funtypes.Literal('browser'), signerName: SignerName.withConstraint((name) => name !== 'NoSigner' && name !== 'NoSignerDetected'), providerId: funtypes.String.withConstraint((id) => id.length > 0 && id.length <= 264) }),
	funtypes.ReadonlyObject({ ...common, type: funtypes.Literal('ledger'), publicKey: PublicKey, derivationPath: DerivationPath }),
	funtypes.ReadonlyObject({ ...common, type: funtypes.Literal('airgap'), publicKey: PublicKey, derivationPath: DerivationPath, sourceFingerprint: funtypes.Number.withConstraint((value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff) }),
).withConstraint((wallet) => {
	if (wallet.type === 'browser') return true
	try {
		if (BigInt(addr.fromPublicKey(bytesFromHex(ensureHex(wallet.publicKey)))) !== wallet.address) return false
		if (wallet.type === 'ledger') return wallet.publicKey.startsWith('0x04')
		return /^m\/44'\/60'\/(0|[1-9][0-9]*)'\/0\/(0|[1-9][0-9]*)$/u.test(wallet.derivationPath) && wallet.publicKey.length === 68
	} catch { return false }
})

export type SigningWalletBinding = funtypes.Static<typeof SigningWalletBinding>
export const SigningWalletBinding = funtypes.ReadonlyObject({
	wallet: SigningWallet,
	revision: funtypes.String.withConstraint((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)),
})

export type SigningWalletBindings = funtypes.Static<typeof SigningWalletBindings>
export const SigningWalletBindings = funtypes.ReadonlyArray(SigningWalletBinding).withConstraint((bindings) => bindings.length <= 10000 && new Set(bindings.map((binding) => binding.wallet.address)).size === bindings.length)
