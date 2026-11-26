let nextId = 0n

// IDs correlate page-local read requests; they are not security tokens and must work on HTTP pages without secure-context crypto APIs.
export function nextSiteHttpApiRequestId() {
	nextId += 1n
	return `interceptor-site-read-${ nextId }`
}
