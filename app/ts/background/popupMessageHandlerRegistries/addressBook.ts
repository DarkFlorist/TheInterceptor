import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { addOrModifyAddressBookEntry, changeAddOrModifyAddressWindowState, getAddressBookData, openNewTab, removeAddressBookEntry, requestAbiAndNameFromBlockExplorer, requestIdentifyAddress, setEnsNameForHash } from '../popupMessageHandlers.js'

export const addressBookPopupMessageHandlers = {
	popup_addOrModifyAddressBookEntry: popupMessageHandler('popup_addOrModifyAddressBookEntry', async (context, request) => await addOrModifyAddressBookEntry(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_getAddressBookData: popupMessageHandler('popup_getAddressBookData', async (_context, request) => await getAddressBookData(request)),
	popup_removeAddressBookEntry: popupMessageHandler('popup_removeAddressBookEntry', async (context, request) => await removeAddressBookEntry(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_openAddressBook: popupMessageHandler('popup_openAddressBook', async () => await openNewTab('addressBook')),
	popup_changeAddOrModifyAddressWindowState: popupMessageHandler('popup_changeAddOrModifyAddressWindowState', async (context, request) => await changeAddOrModifyAddressWindowState(context.ethereum, request)),
	popup_requestAbiAndNameFromBlockExplorer: popupMessageHandler('popup_requestAbiAndNameFromBlockExplorer', async (_context, request) => await requestAbiAndNameFromBlockExplorer(request)),
	popup_setEnsNameForHash: popupMessageHandler('popup_setEnsNameForHash', async (_context, request) => await setEnsNameForHash(request)),
	popup_requestIdentifyAddress: popupMessageHandler('popup_requestIdentifyAddress', async (context, request) => await requestIdentifyAddress(context.ethereum, request)),
} satisfies Partial<PopupMessageHandlerMap>
