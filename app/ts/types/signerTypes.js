"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignerName = void 0;
const funtypes = require("funtypes");
exports.SignerName = funtypes.Union(funtypes.Literal('NoSigner'), funtypes.Literal('NotRecognizedSigner'), funtypes.Literal('MetaMask'), funtypes.Literal('Brave'), funtypes.Literal('CoinbaseWallet'), funtypes.Literal('NoSignerDetected'));
