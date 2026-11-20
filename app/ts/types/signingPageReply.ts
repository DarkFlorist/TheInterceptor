import * as funtypes from 'funtypes'
import { DirectSigningRecord } from './directSigning.js'
import { SigningWalletBindings } from './signingWallet.js'
import { TabState } from './user-interface-types.js'
import type { SendAnywayOverrideReason } from '../utils/sendAnywayConsent.js'

const SendAnywayOverrideReasonCodec: funtypes.Codec<SendAnywayOverrideReason> = funtypes.Union(funtypes.Literal('failingTransaction'), funtypes.Literal('quarantinedTransaction'), funtypes.Literal('quarantinedSignature'))
// The website request's current reviewed result (getPendingRequestReview), which a direct signing approval must name, with the policy the page applies before offering approval.
const PendingRequestReview = funtypes.ReadonlyObject({ reviewedResultId: funtypes.String, rejectOnly: funtypes.Boolean }).And(funtypes.ReadonlyPartial({ sendAnywayReason: SendAnywayOverrideReasonCodec }))
export type PendingRequestReview = funtypes.Static<typeof PendingRequestReview>

const Failure = funtypes.ReadonlyObject({ ok: funtypes.Literal(false), message: funtypes.String })
const MutationReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true) }))
// A verified signature can still be refused when Interceptor resolves the website request with it, for example when a Gnosis Safe's nonce changed while the device was signing. The website request then stays pending with this reason as its signer error, and the signing page must not claim the signature was returned.
const RecordReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true), record: DirectSigningRecord }).And(funtypes.ReadonlyPartial({ signatureRefusalReason: funtypes.String, review: PendingRequestReview })))
const BindingsReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true), bindings: SigningWalletBindings }))
const WalletsReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true), bindings: SigningWalletBindings, tabs: funtypes.ReadonlyArray(TabState) }))

export const signingPageReplyCodecs = {
	signing_walletBindings: BindingsReply,
	signing_wallets: WalletsReply,
	signing_setSafeAccounts: MutationReply,
	signing_saveWallet: MutationReply,
	signing_get: RecordReply,
	signing_approve: RecordReply,
	signing_authorizeDevice: RecordReply,
	signing_result: RecordReply,
	signing_broadcast: RecordReply,
	signing_cancel: RecordReply,
	signing_editFees: RecordReply,
}
export const SigningPageReply = funtypes.Union(WalletsReply, BindingsReply, RecordReply, MutationReply)
export type SigningPageReply = funtypes.Static<typeof SigningPageReply>

export type SigningWalletBindingsSuccess = Extract<funtypes.Static<typeof BindingsReply>, { ok: true }>
export type SigningWalletsSuccess = Extract<funtypes.Static<typeof WalletsReply>, { ok: true }>
export type SigningMutationSuccess = Extract<funtypes.Static<typeof MutationReply>, { ok: true }>
export type SigningRecordSuccess = Extract<funtypes.Static<typeof RecordReply>, { ok: true }>
export type SigningRecordReply = funtypes.Static<typeof RecordReply>
