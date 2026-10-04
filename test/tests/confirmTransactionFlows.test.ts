import { afterEach, beforeEach } from 'bun:test'
import { resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import './safeConfirmationFlows.suite.js'
import './safeStackFlows.suite.js'
import './terminalReplyDelivery.suite.js'

beforeEach(resetConfirmTransactionTestState)
afterEach(async () => await (await import('../../app/ts/background/backgroundTasks.js')).waitForBackgroundTasks())
