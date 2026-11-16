import type { ConfirmationRunId } from '../types/accessRequest.js'

// Compare persisted run identities by value: storage reads create new objects.
export const isSameConfirmationRun = (first: ConfirmationRunId | undefined, second: ConfirmationRunId | undefined) => first !== undefined && second !== undefined && first.lifetime === second.lifetime && first.sequence === second.sequence
