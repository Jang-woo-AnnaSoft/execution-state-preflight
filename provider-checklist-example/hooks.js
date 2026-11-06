"use strict";

// The gate now lives in adopt-example/gate.js, the file an adopter copies. This folder verifies it
//   against hooks-example (v1), with this folder's own declarations as the default.
const gate = require("../adopt-example/gate");
const CONFIRMED = require("./confirmed.json");

module.exports = { ...gate, createHooks: (opts = {}) => gate.createHooks({ confirmed: CONFIRMED, ...opts }) };
