"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMessageError = exports.isTransportEnvelope = exports.isObject = exports.createTransportEventEnvelope = exports.createTransportErrorResponseEnvelope = exports.createTransportSuccessResponseEnvelope = exports.createTransportRequestEnvelope = exports.MessageErrorRuntype = void 0;
const funtypes = require("funtypes");
const ObjectRecord = funtypes.ReadonlyRecord(funtypes.String, funtypes.Unknown);
exports.MessageErrorRuntype = funtypes.Intersect(funtypes.ReadonlyObject({ message: funtypes.String }), funtypes.Partial({
    code: funtypes.Number,
    data: funtypes.Unknown,
}));
function createTransportRequestEnvelope(id, action, payload) {
    return { kind: 'request', id, action, payload };
}
exports.createTransportRequestEnvelope = createTransportRequestEnvelope;
function createTransportSuccessResponseEnvelope(id, action, payload) {
    return { kind: 'response', id, action, ok: true, payload };
}
exports.createTransportSuccessResponseEnvelope = createTransportSuccessResponseEnvelope;
function createTransportErrorResponseEnvelope(id, action, error) {
    return { kind: 'response', id, action, ok: false, error };
}
exports.createTransportErrorResponseEnvelope = createTransportErrorResponseEnvelope;
function createTransportEventEnvelope(action, payload) {
    return { kind: 'event', action, payload };
}
exports.createTransportEventEnvelope = createTransportEventEnvelope;
const TransportEnvelopeRuntype = funtypes.Union(funtypes.ReadonlyObject({
    kind: funtypes.Literal('request'),
    id: funtypes.Number,
    action: funtypes.String,
    payload: funtypes.Unknown,
}), funtypes.ReadonlyObject({
    kind: funtypes.Literal('response'),
    id: funtypes.Number,
    action: funtypes.String,
    ok: funtypes.Literal(true),
    payload: funtypes.Unknown,
}), funtypes.ReadonlyObject({
    kind: funtypes.Literal('response'),
    id: funtypes.Number,
    action: funtypes.String,
    ok: funtypes.Literal(false),
    error: exports.MessageErrorRuntype,
}), funtypes.ReadonlyObject({
    kind: funtypes.Literal('event'),
    action: funtypes.String,
    payload: funtypes.Unknown,
}));
function isObject(value) {
    return ObjectRecord.safeParse(value).success;
}
exports.isObject = isObject;
function isTransportEnvelope(value) {
    return TransportEnvelopeRuntype.safeParse(value).success;
}
exports.isTransportEnvelope = isTransportEnvelope;
function toMessageError(error) {
    if (error instanceof Error)
        return { message: error.message };
    if (isObject(error) && typeof error.message === 'string') {
        return {
            message: error.message,
            ...typeof error.code === 'number' ? { code: error.code } : {},
            ...('data' in error) ? { data: error.data } : {},
        };
    }
    return { message: 'Unknown error' };
}
exports.toMessageError = toMessageError;
