import { requestSafeAppConnection } from './requestSafeAppConnection.js'

// executeScript(files) awaits this script's final expression. The background targets the validated document ID.
requestSafeAppConnection(window.location.origin)
