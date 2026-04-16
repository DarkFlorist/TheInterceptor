"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePageToPageEnvelope = exports.parsePageRequestEnvelope = exports.createPageErrorRequestEnvelope = exports.createPageEventEnvelope = exports.createPageResponseEnvelope = exports.createPageRequestEnvelope = exports.isPageRequestPayload = exports.isPagePortEnvelope = exports.PAGE_RPC_EVENT = exports.PAGE_RPC_RESPONSE = exports.PAGE_RPC_REQUEST = void 0;
const funtypes = require("funtypes");
const interceptor_messages_js_1 = require("../types/interceptor-messages.js");
const wire_types_js_1 = require("../types/wire-types.js");
const shared_js_1 = require("./shared.js");
exports.PAGE_RPC_REQUEST = 'rpc.request';
exports.PAGE_RPC_RESPONSE = 'rpc.response';
exports.PAGE_RPC_EVENT = 'rpc.event';
const PageRequestPayloadRuntype = funtypes.Intersect(funtypes.Union(funtypes.ReadonlyObject({
    method: funtypes.String,
    params: funtypes.Union(funtypes.ReadonlyArray(funtypes.Unknown), funtypes.Undefined),
}).asReadonly(), funtypes.ReadonlyObject({
    method: funtypes.String,
}).asReadonly()), funtypes.ReadonlyObject({
    interceptorRequest: funtypes.Literal(true),
    usingInterceptorWithoutSigner: funtypes.Boolean,
}));
const PageRequestEnvelopeRuntype = funtypes.ReadonlyObject({
    kind: funtypes.Literal('request'),
    id: funtypes.Number,
    action: funtypes.Literal(exports.PAGE_RPC_REQUEST),
    payload: PageRequestPayloadRuntype,
});
const PageResponseEnvelopeRuntype = funtypes.ReadonlyObject({
    kind: funtypes.Literal('response'),
    id: funtypes.Number,
    action: funtypes.Literal(exports.PAGE_RPC_RESPONSE),
    ok: funtypes.Literal(true),
    payload: interceptor_messages_js_1.InterceptorMessageToInpage,
});
const PageErrorResponseEnvelopeRuntype = funtypes.ReadonlyObject({
    kind: funtypes.Literal('response'),
    id: funtypes.Number,
    action: funtypes.Literal(exports.PAGE_RPC_RESPONSE),
    ok: funtypes.Literal(false),
    error: shared_js_1.MessageErrorRuntype,
});
const PageEventEnvelopeRuntype = funtypes.ReadonlyObject({
    kind: funtypes.Literal('event'),
    action: funtypes.Literal(exports.PAGE_RPC_EVENT),
    payload: interceptor_messages_js_1.InterceptorMessageToInpage,
});
const serializePageMessage = (message) => (0, wire_types_js_1.serialize)(interceptor_messages_js_1.InterceptorMessageToInpage, message);
function isPagePortEnvelope(value) {
    return PageRequestEnvelopeRuntype.safeParse(value).success
        || PageResponseEnvelopeRuntype.safeParse(value).success
        || PageErrorResponseEnvelopeRuntype.safeParse(value).success
        || PageEventEnvelopeRuntype.safeParse(value).success;
}
exports.isPagePortEnvelope = isPagePortEnvelope;
function isPageRequestPayload(value) {
    return PageRequestPayloadRuntype.safeParse(value).success;
}
exports.isPageRequestPayload = isPageRequestPayload;
function createPageRequestEnvelope(id, payload) {
    return (0, shared_js_1.createTransportRequestEnvelope)(id, exports.PAGE_RPC_REQUEST, payload);
}
exports.createPageRequestEnvelope = createPageRequestEnvelope;
function createPageResponseEnvelope(id, message) {
    return (0, shared_js_1.createTransportSuccessResponseEnvelope)(id, exports.PAGE_RPC_RESPONSE, serializePageMessage(message));
}
exports.createPageResponseEnvelope = createPageResponseEnvelope;
function createPageEventEnvelope(message) {
    return (0, shared_js_1.createTransportEventEnvelope)(exports.PAGE_RPC_EVENT, serializePageMessage(message));
}
exports.createPageEventEnvelope = createPageEventEnvelope;
function createPageErrorRequestEnvelope(id, message) {
    return createPageRequestEnvelope(id, {
        interceptorRequest: true,
        usingInterceptorWithoutSigner: false,
        method: 'InterceptorError',
        params: [message],
    });
}
exports.createPageErrorRequestEnvelope = createPageErrorRequestEnvelope;
function parsePageRequestEnvelope(value) {
    const parsed = PageRequestEnvelopeRuntype.safeParse(value);
    return parsed.success ? parsed.value : undefined;
}
exports.parsePageRequestEnvelope = parsePageRequestEnvelope;
function parsePageToPageEnvelope(value) {
    const response = PageResponseEnvelopeRuntype.safeParse(value);
    if (response.success)
        return response.value;
    const errorResponse = PageErrorResponseEnvelopeRuntype.safeParse(value);
    if (errorResponse.success)
        return errorResponse.value;
    const event = PageEventEnvelopeRuntype.safeParse(value);
    if (event.success)
        return event.value;
    return undefined;
}
exports.parsePageToPageEnvelope = parsePageToPageEnvelope;
