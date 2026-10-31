import { beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './terminalReplyDelivery.suite.js'
import './sendAnywayConsent.suite.js'

beforeEach(resetConfirmTransactionTestState)
