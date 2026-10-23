// Authority and leases share one private collection-scoped owner and lifecycle.
export {
	acquireSignerSelectionLease,
	releaseSignerSelectionLease,
	signerSelectionLeaseIsActive,
	releaseSignerSelectionLeasesForSocket,
	runWithSignerSelectionGate,
	registerAuthoritativeTopSocket as registerTopSignerDocument,
} from './signerExecutionAuthority.js'
