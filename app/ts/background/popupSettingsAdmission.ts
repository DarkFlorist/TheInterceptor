import { createPopupSettingsCoordinator } from './popupSettingsCoordinator.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'

// One admission boundary for popup commands and settings-file imports.
export const popupSettingsCoordinator = createPopupSettingsCoordinator(async (data) => await sendPopupMessageToOpenWindows({ method: 'popup_settingsChangeStatus', data }))
