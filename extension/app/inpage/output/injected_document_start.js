"use strict";
function listenInContentScript() {
    /**
     * this script executed within the context of the active tab when the user clicks the extension bar button
     * this script serves as a _very thin_ proxy between the page scripts (dapp) and the extension, simply forwarding messages between the two
    */
    // the content script is a very thin proxy between the background script and the page script
    const extensionPort = browser.runtime.connect();
    let connected = true;
    // forward all message events to the background script, which will then filter and process them
    window.addEventListener('message', messageEvent => {
        try {
            // we only want the data element, if it exists, and postMessage will fail if it can't clone the object fully (and it cannot clone a MessageEvent)
            if (!('data' in messageEvent))
                return;
            if (connected)
                extensionPort.postMessage({ data: messageEvent.data });
        }
        catch (error) {
            // CONSIDER: should we catch data clone error and then do `extensionPort.postMessage({data:JSON.parse(JSON.stringify(messageEvent.data))})`?
            if (error instanceof Error) {
                if (error.message?.includes('Extension context invalidated.')) {
                    // this error happens when the extension is refreshed and the page cannot reach The Interceptor anymore
                    return;
                }
            }
            throw error;
        }
    });
    // forward all messages we get from the background script to the window so the page script can filter and process them
    extensionPort.onMessage.addListener(response => {
        try {
            if (connected)
                window.postMessage(response, '*');
        }
        catch (error) {
            console.error(error);
        }
    });
    extensionPort.onDisconnect.addListener(() => {
        connected = false;
    });
}
function injectScript(content) {
    try {
        const container = document.head || document.documentElement;
        const scriptTag = document.createElement('script');
        scriptTag.setAttribute('async', 'false');
        scriptTag.textContent = content;
        container.insertBefore(scriptTag, container.children[0]);
        container.removeChild(scriptTag);
        listenInContentScript();
    }
    catch (error) {
        console.error('Interceptor: Provider injection failed.', error);
    }
}
injectScript(`"use strict";
const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001;
const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902;
class InterceptorFuture {
    constructor() {
        this.then = (onfulfilled, onrejected) => {
            return this.promise.then(onfulfilled, onrejected);
        };
        this.resolve = (value) => {
            this.resolveFunction(value);
        };
        this.reject = (reason) => {
            this.rejectFunction(reason);
        };
        let resolveFunction;
        let rejectFunction;
        this.promise = new Promise((resolve, reject) => {
            resolveFunction = resolve;
            rejectFunction = reject;
        });
        // the function passed to the Promise constructor is called before the constructor returns, so we can be sure the resolve and reject functions have been set by here even if the compiler can't verify
        this.resolveFunction = resolveFunction;
        this.rejectFunction = rejectFunction;
    }
}
class EthereumJsonRpcError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = this.constructor.name;
    }
}
class InterceptorMessageListener {
    constructor() {
        this.connected = false;
        this.requestId = 0;
        this.usingInterceptorWithoutSigner = true;
        this.outstandingRequests = new Map();
        this.onMessageCallBacks = new Set();
        this.onConnectCallBacks = new Set();
        this.onAccountsChangedCallBacks = new Set();
        this.onDisconnectCallBacks = new Set();
        this.onChainChangedCallBacks = new Set();
        this.WindowEthereumIsConnected = () => {
            return this.connected;
        };
        // sends messag to The Interceptor background page
        this.WindowEthereumRequest = async (options) => {
            this.requestId++;
            const currentRequestId = this.requestId;
            const future = new InterceptorFuture();
            this.outstandingRequests.set(currentRequestId, future);
            try {
                // make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
                this.sendMessageToBackgroundPage({ method: options.method, params: options.params }, currentRequestId);
                return await future; //TODO: we need to figure out somekind of timeout here, it needs to depend on the request type, eg. if we are asking user to sign something, maybe there shouldn't even be a timeout?
            }
            catch (error) {
                // if it is an Error, add context to it if context doesn't already exist
                if (error instanceof Error) {
                    if (!('code' in error))
                        error.code = -32603;
                    if (!('data' in error) || error.data === undefined || error.data === null)
                        error.data = { request: options };
                    else if (!('request' in error.data))
                        error.data.request = options;
                    throw error;
                }
                // if someone threw something besides an Error, wrap it up in an error
                throw new EthereumJsonRpcError(-32603, \`Unexpected thrown value.\`, { error: error, request: options });
            }
            finally {
                this.outstandingRequests.delete(currentRequestId);
            }
        };
        // 🤬 Uniswap, among others, require \`send\` to be implemented even though it was never part of any final specification.
        // To make matters worse, some versions of send will have a first parameter that is an object (like \`request\`) and others will have a first and second parameter.
        // On top of all that, some applications have a mix of both!
        this.WindowEthereumSend = async (method, params) => {
            if (typeof method === 'object') {
                return await this.WindowEthereumRequest({ method: method.method, params: method.params });
            }
            else {
                return await this.WindowEthereumRequest({ method, params });
            }
        };
        this.WindowEthereumSendAsync = async (payload, callback) => {
            this.WindowEthereumRequest(payload)
                .then(result => callback(null, { jsonrpc: '2.0', id: payload.id, result }))
                // since \`request(...)\` only throws things shaped like \`JsonRpcError\`, we can rely on it having those properties.
                .catch(error => callback({ jsonrpc: '2.0', id: payload.id, error: { code: error.code, message: error.message, data: { ...error.data, stack: error.stack } } }, null));
        };
        this.WindowEthereumOn = async (kind, callback) => {
            switch (kind) {
                case 'accountsChanged':
                    this.onAccountsChangedCallBacks.add(callback);
                    return;
                case 'message':
                    this.onMessageCallBacks.add(callback);
                    return;
                case 'connect':
                    this.onConnectCallBacks.add(callback);
                    return;
                case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
                    this.onDisconnectCallBacks.add(callback);
                    return;
                case 'disconnect':
                    this.onDisconnectCallBacks.add(callback);
                    return;
                case 'chainChanged':
                    this.onChainChangedCallBacks.add(callback);
                    return;
                default:
            }
        };
        this.WindowEthereumRemoveListener = async (kind, callback) => {
            switch (kind) {
                case 'accountsChanged':
                    this.onAccountsChangedCallBacks.delete(callback);
                    return;
                case 'message':
                    this.onMessageCallBacks.delete(callback);
                    return;
                case 'connect':
                    this.onConnectCallBacks.delete(callback);
                    return;
                case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
                    this.onDisconnectCallBacks.delete(callback);
                    return;
                case 'disconnect':
                    this.onDisconnectCallBacks.delete(callback);
                    return;
                case 'chainChanged':
                    this.onChainChangedCallBacks.delete(callback);
                    return;
                default:
            }
        };
        this.WindowEthereumEnable = async () => {
            this.WindowEthereumRequest({ method: 'eth_requestAccounts' });
        };
        this.requestAccountsFromSigner = async () => {
            if (this.signerWindowEthereumRequest === undefined)
                return;
            const reply = await this.signerWindowEthereumRequest({ method: 'eth_requestAccounts', params: [] });
            if (!Array.isArray(reply))
                return;
            this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: reply });
        };
        this.requestChainIdFromSigner = async () => {
            if (this.signerWindowEthereumRequest === undefined)
                return;
            const reply = await this.signerWindowEthereumRequest({ method: 'eth_chainId', params: [] });
            if (typeof reply !== 'string')
                return;
            this.sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [reply] });
        };
        this.requestChangeChainFromSigner = async (chainId) => {
            if (this.signerWindowEthereumRequest === undefined)
                return;
            try {
                const reply = await this.signerWindowEthereumRequest({ method: 'wallet_switchEthereumChain', params: [{ 'chainId': chainId }] });
                if (reply !== null)
                    return;
                this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId: chainId }] });
            }
            catch (error) {
                if (InterceptorMessageListener.checkErrorForCode(error) && (error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
                    this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [{ accept: false, chainId: chainId }] });
                }
                throw error;
            }
        };
        this.handleReplyRequest = async (replyRequest) => {
            if (replyRequest.subscription !== undefined) {
                return this.onMessageCallBacks.forEach((f) => f({ type: 'eth_subscription', data: replyRequest.result }));
            }
            // inform callbacks
            if (replyRequest.options.method === 'accountsChanged') {
                return this.onAccountsChangedCallBacks.forEach((f) => f(replyRequest.result));
            }
            if (replyRequest.options.method === 'connect') {
                this.connected = true;
                return this.onConnectCallBacks.forEach((f) => f({ chainId: replyRequest.result }));
            }
            if (replyRequest.options.method === 'disconnect') {
                this.connected = false;
                const resultArray = replyRequest.result;
                return this.onDisconnectCallBacks.forEach((f) => f({ name: 'disconnect', ...resultArray }));
            }
            if (replyRequest.options.method === 'chainChanged') {
                return this.onChainChangedCallBacks.forEach((f) => f(replyRequest.result));
            }
            // The Interceptor requested us to request informatio from igner
            if (replyRequest.options.method === 'request_signer_to_eth_requestAccounts') {
                // when dapp requsts eth_requestAccounts, interceptor needs to reply to it, but we also need to try to sign to the signer
                return await this.requestAccountsFromSigner();
            }
            if (replyRequest.options.method === 'request_signer_to_wallet_switchEthereumChain') {
                return await this.requestChangeChainFromSigner(replyRequest.result);
            }
            if (replyRequest.options.method === 'request_signer_chainId') {
                return await this.requestChainIdFromSigner();
            }
            if (replyRequest.requestId === undefined)
                throw new Error('Reply request missing requestId');
            return this.outstandingRequests.get(replyRequest.requestId).resolve(replyRequest.result);
        };
        this.onMessage = async (messageEvent) => {
            if (typeof messageEvent !== 'object'
                || messageEvent === null
                || !('data' in messageEvent)
                || typeof messageEvent.data !== 'object'
                || messageEvent.data === null
                || !('interceptorApproved' in messageEvent.data))
                return;
            if (!('ethereum' in window) || !window.ethereum)
                throw new Error('window.ethereum missing');
            if (!('options' in messageEvent.data && typeof messageEvent.data.options === 'object' && messageEvent.data.options !== null))
                throw new Error('missing options field');
            if (!('method' in messageEvent.data.options))
                throw new Error('missing method field');
            if (!('param' in messageEvent.data.options))
                throw new Error('missing param field');
            const forwardRequest = messageEvent.data; //use "as" here as we don't want to inject funtypes here
            if (forwardRequest.error !== undefined) {
                if (forwardRequest.requestId === undefined || !this.outstandingRequests.has(forwardRequest.requestId))
                    throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message);
                return this.outstandingRequests.get(forwardRequest.requestId).reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message));
            }
            if (forwardRequest.result !== undefined)
                return this.handleReplyRequest(forwardRequest);
            try {
                if (this.usingInterceptorWithoutSigner)
                    throw 'Interceptor is in wallet mode and should not forward to an external wallet';
                if (this.signerWindowEthereumRequest == undefined)
                    throw 'signer not found';
                const reply = await this.signerWindowEthereumRequest(forwardRequest.options);
                if (forwardRequest.requestId === undefined)
                    return;
                this.outstandingRequests.get(forwardRequest.requestId).resolve(reply);
            }
            catch (error) {
                // if it is an Error, add context to it if context doesn't already exist
                console.log(error);
                console.log(messageEvent);
                if (forwardRequest.requestId === undefined)
                    throw error;
                if (error instanceof Error) {
                    if (!('code' in error))
                        error.code = -32603;
                    if (!('data' in error) || error.data === undefined || error.data === null)
                        error.data = { request: forwardRequest.options };
                    else if (!('request' in error.data))
                        error.data.request = forwardRequest.options;
                    return this.outstandingRequests.get(forwardRequest.requestId).reject(error);
                }
                if (error.code !== undefined && error.message !== undefined) {
                    return this.outstandingRequests.get(forwardRequest.requestId).reject(new EthereumJsonRpcError(error.code, error.message, { request: forwardRequest.options }));
                }
                // if the signer we are connected threw something besides an Error, wrap it up in an error
                this.outstandingRequests.get(forwardRequest.requestId).reject(new EthereumJsonRpcError(-32603, \`Unexpected thrown value.\`, { error: error, request: forwardRequest.options }));
            }
        };
        this.sendMessageToBackgroundPage = (messageMethodAndParams, requestId = undefined) => {
            window.postMessage({
                interceptorRequest: true,
                options: {
                    method: messageMethodAndParams.method,
                    params: messageMethodAndParams.params,
                },
                usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
                ...(requestId === undefined ? {} : { requestId: requestId })
            }, '*');
        };
        this.sendConnectedMessage = (signerName) => {
            this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [signerName] });
        };
        this.injectEthereumIntoWindow = () => {
            if (!('ethereum' in window) || !window.ethereum) {
                // no existing signer found
                window.ethereum = {
                    isConnected: this.WindowEthereumIsConnected,
                    request: this.WindowEthereumRequest,
                    send: this.WindowEthereumSend,
                    sendAsync: this.WindowEthereumSendAsync,
                    on: this.WindowEthereumOn,
                    removeListener: this.WindowEthereumRemoveListener,
                    enable: this.WindowEthereumEnable
                };
                this.usingInterceptorWithoutSigner = true;
                this.connected = true;
                return this.sendConnectedMessage('NoSigner');
            }
            // subscribe for signers events
            window.ethereum.on('accountsChanged', (accounts) => {
                this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: accounts });
            });
            window.ethereum.on('connect', (_connectInfo) => {
            });
            window.ethereum.on('disconnect', (_error) => {
                this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: [] });
            });
            window.ethereum.on('chainChanged', (chainId) => {
                this.WindowEthereumRequest({ method: 'signer_chainChanged', params: [chainId] });
            });
            this.connected = window.ethereum.isConnected();
            this.signerWindowEthereumRequest = window.ethereum.request; // store the request object to signer
            this.usingInterceptorWithoutSigner = false;
            if (window.ethereum.isBraveWallet) {
                window.ethereum = {
                    isConnected: this.WindowEthereumIsConnected,
                    request: this.WindowEthereumRequest,
                    send: this.WindowEthereumSend,
                    sendAsync: this.WindowEthereumSendAsync,
                    on: this.WindowEthereumOn,
                    removeListener: this.WindowEthereumRemoveListener,
                    enable: this.WindowEthereumEnable
                };
                this.sendConnectedMessage('Brave');
            }
            else {
                // we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
                window.ethereum.isConnected = this.WindowEthereumIsConnected;
                window.ethereum.request = this.WindowEthereumRequest;
                window.ethereum.send = this.WindowEthereumSend;
                window.ethereum.sendAsync = this.WindowEthereumSendAsync;
                window.ethereum.on = this.WindowEthereumOn;
                window.ethereum.removeListener = this.WindowEthereumRemoveListener;
                window.ethereum.enable = this.WindowEthereumEnable;
                this.sendConnectedMessage(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner');
            }
        };
        this.signerWindowEthereumRequest = undefined;
        this.injectEthereumIntoWindow();
    }
}
InterceptorMessageListener.checkErrorForCode = (error) => {
    if (typeof error !== 'object')
        return false;
    if (error === null)
        return false;
    if (!('code' in error))
        return false;
    if (typeof error.code !== 'number')
        return false;
    return true;
};
function inject() {
    const interceptorMessageListener = new InterceptorMessageListener();
    window.addEventListener('message', interceptorMessageListener.onMessage);
    // listen if Metamask injects their payload, and if so, reinject Interceptor
    const interceptorCapturedDispatcher = window.dispatchEvent;
    window.dispatchEvent = (event) => {
        interceptorCapturedDispatcher(event);
        if (!(typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string'))
            return;
        if (event.type !== 'ethereum#initialized')
            return;
        interceptorMessageListener.injectEthereumIntoWindow();
        window.dispatchEvent = interceptorCapturedDispatcher;
    };
}
inject();
//# sourceMappingURL=inpage.js.map`);
