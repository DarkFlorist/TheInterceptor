import * as delivery from './terminalReplyDelivery.js'
import { routeProviderReply } from './providerReplyRouting.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'

export { queueTerminalReply } from './terminalReplyDelivery.js'
export const attemptQueuedTerminalReplyDelivery = (connections: WebsiteTabConnections, message: InterceptedRequestForward) => delivery.attemptQueuedTerminalReplyDelivery(connections, message, routeProviderReply)
export const queueTerminalReplyAndAttemptDelivery = (connections: WebsiteTabConnections, message: InterceptedRequestForward) => delivery.queueTerminalReplyAndAttemptDelivery(connections, message, routeProviderReply)
export const flushPendingTerminalRepliesForSocket = (connections: WebsiteTabConnections, socket: WebsiteSocket) => delivery.flushPendingTerminalRepliesForSocket(connections, socket, routeProviderReply)
export const flushPendingTerminalRepliesForConnectedPortWithRetry = (connections: WebsiteTabConnections, socket: WebsiteSocket, port: browser.runtime.Port) => delivery.flushPendingTerminalRepliesForConnectedPortWithRetry(connections, socket, port, routeProviderReply)
