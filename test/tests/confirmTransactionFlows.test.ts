import { beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './confirmationResolutionRaces.suite.js'
import './plainTextPersonalSignConfirmation.suite.js'
import './failedTransactionPreview.suite.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './signInWithEthereumConfirmation.suite.js'
import './confirmTransactionStrandedSimulation.suite.js'
import './confirmTransactionSimulationAbortOrder.suite.js'
import './terminalReplyDelivery.suite.js'
import './sendAnywayConsent.suite.js'

beforeEach(resetConfirmTransactionTestState)
