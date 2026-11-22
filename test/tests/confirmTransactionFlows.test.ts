import { afterEach, beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './confirmationRequestIdReuse.suite.js'
import './metadataLookupChain.suite.js'
import './failedTransactionPreview.suite.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './signingModeApprovalAfterSimulationMode.suite.js'
import './signInWithEthereumConfirmation.suite.js'
import './confirmTransactionStrandedSimulation.suite.js'
import './confirmTransactionSimulationAbortOrder.suite.js'
import './terminalReplyDelivery.suite.js'
import './transactionCreationFailureReason.suite.js'
import './sendAnywayConsent.suite.js'

beforeEach(resetConfirmTransactionTestState)
afterEach(async () => await (await import('./backgroundTasksTestHarness.js')).waitForBackgroundTasks())

import './requestIdentity.suite.js'
