import { registerPageExtension } from './pageExtensions.js'
import { createSiteBehaviorExtensions } from './siteBehaviorExtensions.js'

// Keep vendor adapters and fetch hooks outside the wallet provider. Native-host SDKs may retain fetch before context arrives, so this separate entrypoint installs an inert early hook there; ordinary pages wait for live capabilities.
registerPageExtension(window, 'site-behavior', (requestRpc) => createSiteBehaviorExtensions(window, requestRpc, window.parent !== window && /^(?:chrome|moz)-extension:\/\//.test(window.location.ancestorOrigins?.[0] ?? window.document?.referrer ?? '')))
