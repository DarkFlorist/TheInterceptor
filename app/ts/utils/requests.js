"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promiseAllMapAbortSafe = exports.silenceChromeUnCaughtPromise = exports.getHostWithPort = exports.checkAndPrintRuntimeLastError = exports.checkAndThrowRuntimeLastError = exports.updateWindowIfExists = exports.updateTabIfExists = exports.safeGetWindow = exports.doesTabExist = exports.safeGetTab = exports.fetchWithTimeout = exports.doesUniqueRequestIdentifiersMatch = exports.getUniqueRequestIdentifierString = exports.InterceptedRequest = exports.RawInterceptedRequest = exports.UniqueRequestIdentifier = exports.WebsiteSocket = void 0;
const funtypes = require("funtypes");
const wire_types_js_1 = require("../types/wire-types.js");
const anySignal_js_1 = require("./anySignal.js");
exports.WebsiteSocket = funtypes.ReadonlyObject({
    tabId: funtypes.Number,
    connectionName: wire_types_js_1.EthereumQuantity,
});
exports.UniqueRequestIdentifier = funtypes.ReadonlyObject({
    requestId: funtypes.Number,
    requestSocket: exports.WebsiteSocket,
}).asReadonly();
exports.RawInterceptedRequest = funtypes.Intersect(funtypes.Union(funtypes.ReadonlyObject({
    method: funtypes.String,
    params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
}).asReadonly(), funtypes.ReadonlyObject({ method: funtypes.String }).asReadonly()), funtypes.ReadonlyObject({
    interceptorRequest: funtypes.Boolean,
    usingInterceptorWithoutSigner: funtypes.Boolean,
    requestId: funtypes.Number,
}));
exports.InterceptedRequest = funtypes.Intersect(funtypes.Union(funtypes.ReadonlyObject({
    method: funtypes.String,
    params: funtypes.Union(funtypes.Array(funtypes.Unknown), funtypes.Undefined)
}).asReadonly(), funtypes.ReadonlyObject({ method: funtypes.String }).asReadonly()), funtypes.ReadonlyObject({
    interceptorRequest: funtypes.Boolean,
    usingInterceptorWithoutSigner: funtypes.Boolean,
    uniqueRequestIdentifier: exports.UniqueRequestIdentifier,
}));
const getUniqueRequestIdentifierString = (uniqueRequestIdentifier) => {
    return `${uniqueRequestIdentifier.requestSocket.tabId}-${uniqueRequestIdentifier.requestSocket.connectionName}-${uniqueRequestIdentifier.requestId}`;
};
exports.getUniqueRequestIdentifierString = getUniqueRequestIdentifierString;
const doesUniqueRequestIdentifiersMatch = (a, b) => {
    return a.requestId === b.requestId && a.requestSocket.connectionName === b.requestSocket.connectionName && a.requestSocket.tabId === b.requestSocket.tabId;
};
exports.doesUniqueRequestIdentifiersMatch = doesUniqueRequestIdentifiersMatch;
async function fetchWithTimeout(resource, init, timeoutMs, requestAbortController = undefined) {
    const timeoutAbortController = new AbortController();
    const timeoutId = setTimeout(() => timeoutAbortController.abort(new Error('Fetch request timed out.')), timeoutMs);
    const requestAndTimeoutSignal = requestAbortController === undefined ? timeoutAbortController.signal : (0, anySignal_js_1.anySignal)([timeoutAbortController.signal, requestAbortController.signal]);
    try {
        if (requestAndTimeoutSignal.aborted)
            throw requestAndTimeoutSignal.reason;
        return await fetch(resource, { ...init, signal: requestAndTimeoutSignal });
    }
    catch (error) {
        if (error instanceof DOMException && error.message === 'The user aborted a request.')
            throw new Error('Fetch request timed out.');
        throw error;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
exports.fetchWithTimeout = fetchWithTimeout;
const safeGetTab = async (tabId) => {
    try {
        const tab = await browser.tabs.get(tabId);
        (0, exports.checkAndThrowRuntimeLastError)();
        return tab;
    }
    catch (e) {
        return undefined;
    }
};
exports.safeGetTab = safeGetTab;
const doesTabExist = async (tabId) => {
    const tab = await (0, exports.safeGetTab)(tabId);
    if (tab === undefined)
        return false;
    return true;
};
exports.doesTabExist = doesTabExist;
const safeGetWindow = async (windowId) => {
    try {
        const tab = await browser.windows.get(windowId);
        (0, exports.checkAndThrowRuntimeLastError)();
        return tab;
    }
    catch (e) {
        return undefined;
    }
};
exports.safeGetWindow = safeGetWindow;
const updateTabIfExists = async (tabId, updateProperties) => {
    try {
        const tab = await browser.tabs.update(tabId, updateProperties);
        (0, exports.checkAndThrowRuntimeLastError)();
        return tab;
    }
    catch (e) {
        return undefined;
    }
};
exports.updateTabIfExists = updateTabIfExists;
const updateWindowIfExists = async (windowId, updateProperties) => {
    try {
        const window = await browser.windows.update(windowId, updateProperties);
        (0, exports.checkAndThrowRuntimeLastError)();
        return window;
    }
    catch (e) {
        return undefined;
    }
};
exports.updateWindowIfExists = updateWindowIfExists;
const checkAndThrowRuntimeLastError = () => {
    const error = browser.runtime.lastError; // firefox return `null` on no errors
    if (error !== null && error !== undefined && error.message !== undefined)
        throw new Error(error.message);
};
exports.checkAndThrowRuntimeLastError = checkAndThrowRuntimeLastError;
const checkAndPrintRuntimeLastError = () => {
    const error = browser.runtime.lastError; // firefox return `null` on no errors
    // biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
    if (error !== null && error !== undefined && error.message !== undefined)
        console.log(error);
};
exports.checkAndPrintRuntimeLastError = checkAndPrintRuntimeLastError;
const getHostWithPort = (urlString) => {
    const url = new URL(urlString);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
};
exports.getHostWithPort = getHostWithPort;
const silenceChromeUnCaughtPromise = async (maybeAwaitedFunction) => {
    maybeAwaitedFunction.catch(() => undefined);
    return maybeAwaitedFunction;
};
exports.silenceChromeUnCaughtPromise = silenceChromeUnCaughtPromise;
async function promiseAllMapAbortSafe(values, mapper) {
    const guardedPromises = values.map(async (value, index) => {
        const promise = mapper(value, index);
        promise.catch(() => undefined);
        return await promise;
    });
    return await (0, exports.silenceChromeUnCaughtPromise)(Promise.all(guardedPromises));
}
exports.promiseAllMapAbortSafe = promiseAllMapAbortSafe;
