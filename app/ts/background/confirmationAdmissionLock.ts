import { Semaphore } from '../utils/semaphore.js'

// The one admission lock of the confirmation queue, which every confirmation flow holds while it adds a request.
const pendingConfirmationSemaphore = new Semaphore(1)
// Requests are added to the confirmation queue one at a time while holding this lock.
export const runWithPendingConfirmationLock = async <T>(run: () => Promise<T>) => await pendingConfirmationSemaphore.execute(run)
