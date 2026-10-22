import type { TransactionCreationError } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { getFailureReasonForDisplay } from './failureReasons.js'
import { appendProtocolRevertReasonHints } from './revertReasonHints.js'

// The only derivation of the reason shown when a transaction fails to be created: the insufficient balance explanation overrides the decoded revert reason.
export const getTransactionCreationFailureReason = (errorAbis: readonly AbiLike[], error: TransactionCreationError) => error.insufficientBalanceMessage ?? getFailureReasonForDisplay(errorAbis, error, appendProtocolRevertReasonHints)
