import { backgroundTaskSupervisor } from '../../app/ts/background/backgroundTasks.js'

// Observe the same supervisor and completions used by the extension; no test execution wrapper.
export const waitForBackgroundTasks = backgroundTaskSupervisor.waitForIdle
