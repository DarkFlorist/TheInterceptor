import { installSafeAppsHost } from './safeAppsHost.js'
import { installRequestFinanceDiscoveryAdapter } from './requestFinanceSafeDiscoveryAdapter.js'

// Keep persisted registrations from the previous build executable until the background replaces them.
if (window.location.origin === 'https://app.request.finance') installSafeAppsHost(installRequestFinanceDiscoveryAdapter)
