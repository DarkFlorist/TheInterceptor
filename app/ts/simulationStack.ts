import { getHtmlFile } from './background/backgroundUtils.js'
import { redirectStandalonePageToManagementShell } from './utils/managementLocation.js'

// Pre-shell standalone URL kept only so saved links keep working; the page itself renders only inside the management shell.
redirectStandalonePageToManagementShell('simulation-stack', getHtmlFile('managementView'))
