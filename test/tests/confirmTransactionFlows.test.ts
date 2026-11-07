import { beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './confirmationRequestIdReuse.suite.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './terminalReplyDelivery.suite.js'

beforeEach(resetConfirmTransactionTestState)
