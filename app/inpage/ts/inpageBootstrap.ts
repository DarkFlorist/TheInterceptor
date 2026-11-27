import { isExtensionFrameFetchPreparationHint } from './extensionFrameFetchPreparation.js'
import { injectInterceptor } from './inpage.js'
import { createSiteBehaviorExtensions } from './siteBehaviorExtensions.js'

// A private composition root wires the independently owned HTTP feature to the core. No page script can register a factory or obtain the provider's internal request callback.
injectInterceptor((sendRequest) => createSiteBehaviorExtensions(window, async (chainId, request) => await sendRequest({ method: 'site_rpc_request', params: [{ chainId, request }] }), isExtensionFrameFetchPreparationHint({ framed: window.parent !== window, ancestorOrigin: window.location?.ancestorOrigins?.[0], referrer: window.document?.referrer })))
