import { Semaphore } from '../utils/semaphore.js'

// Pending requests and their durable terminal replies form one storage invariant: a reply may only become deliverable in the same critical section that marks its request terminal. Every writer of either side must use this shared semaphore.
export const pendingRequestTerminalStateSemaphore = new Semaphore(1)
