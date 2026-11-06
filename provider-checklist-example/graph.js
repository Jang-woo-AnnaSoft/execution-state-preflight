"use strict";

// The LangGraph flow lives in adopt-example/gate.js. This folder runs it with its own declarations.
const gate = require("../adopt-example/gate");
const TOOL = require("./tool.json");
const CONFIRMED = require("./confirmed.json");

module.exports = { ...gate, buildGraph: (opts = {}) => gate.buildGraph({ tool: TOOL, confirmed: CONFIRMED, ...opts }) };
