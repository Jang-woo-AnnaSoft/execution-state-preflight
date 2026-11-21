"use strict";

/**
 * [ANSWER SHAPES] Every stand-in answer the tests give the gate fits the shape the gate handed with the
 * call (judge-only.js SHAPES, sent to the model through withStructuredOutput). A shape narrower than
 * what the gate takes would refuse answers the gate reads today: this is where that shows.
 *
 *   const shapes = require("./shape-check");
 *   connect.ask = shapes.watch(connect.ask);     // in each stand-in
 *   shapes.report(check);                         // once, at the end
 */

const path = require("path");
const Ajv = require(path.join(__dirname, "..", "adopt-example", "node_modules", "ajv"));
const ajv = new Ajv({ allErrors: true, strict: false });
const seen = { calls: 0, noShape: new Set(), misfit: [] };

function watch(ask) {
  return async (model, system, user, hook, schema) => {
    const out = await ask(model, system, user, hook, schema);
    seen.calls++;
    if (!schema || typeof schema !== "object") { seen.noShape.add(hook); return out; }
    const fits = ajv.validate(schema, out);
    if (!fits && seen.misfit.length < 5) seen.misfit.push(`${hook}: ${ajv.errorsText(ajv.errors)} in ${JSON.stringify(out).slice(0, 160)}`);
    return out;
  };
}

function report(check) {
  check(`every call to a model came with a shape (${seen.calls} calls)`, [seen.calls > 0, [...seen.noShape]], [true, []]);
  check("  every stand-in answer fits the shape it came with", seen.misfit, []);
}

module.exports = { watch, report };
