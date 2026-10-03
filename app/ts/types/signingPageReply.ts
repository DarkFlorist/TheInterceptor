import * as funtypes from 'funtypes'
import { DirectSigningRecord } from './directSigning.js'
import { SigningWalletBindings } from './signingWallet.js'
import { TabState } from './user-interface-types.js'

const Failure = funtypes.ReadonlyObject({ ok: funtypes.Literal(false), message: funtypes.String })
const MutationReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true) }))
const RecordReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true), record: DirectSigningRecord }))
const WalletsReply = funtypes.Union(Failure, funtypes.ReadonlyObject({ ok: funtypes.Literal(true), bindings: SigningWalletBindings, tabs: funtypes.ReadonlyArray(TabState) }))

export const signingPageReplyCodecs = {
	signing_wallets: WalletsReply,
	signing_setSafeAccounts: MutationReply,
	signing_saveWallet: MutationReply,
	signing_get: RecordReply,
	signing_approve: RecordReply,
	signing_result: RecordReply,
	signing_broadcast: RecordReply,
	signing_cancel: RecordReply,
	signing_editFees: RecordReply,
}
export const SigningPageReply = funtypes.Union(WalletsReply, RecordReply, MutationReply)
export type SigningPageReply = funtypes.Static<typeof SigningPageReply>
