import { beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './confirmTransactionSimulationId.suite.js'
import './makeRichAddressSelection.suite.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './stackSimulationContext.suite.js'
import './terminalReplyDelivery.suite.js'
import './walletSendCallsConfirmation.suite.js'

beforeEach(resetConfirmTransactionTestState)
