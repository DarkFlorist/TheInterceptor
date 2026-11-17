import { beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './confirmTransactionSimulationAbortOrder.suite.js'
import './confirmTransactionStrandedSimulation.suite.js'

import './failedTransactionPreview.suite.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './sendAnywayConsent.suite.js'
import './signInWithEthereumConfirmation.suite.js'
import './simulatedTransactionHashes.suite.js'
import './terminalReplyDelivery.suite.js'

beforeEach(resetConfirmTransactionTestState)

import './requestIdentity.suite.js'
import './requestResolution.suite.js'
