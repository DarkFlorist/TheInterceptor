// Convenience exports for pending-work callers; enforcement belongs to the storage owner, whose raw creation writers are private. Neither import path bypasses the selection reservation.
export { appendPendingTransactionOrMessage, setChainChangeConfirmationPromise } from './storageVariables.js'
