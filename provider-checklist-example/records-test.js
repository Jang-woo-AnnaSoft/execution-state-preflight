"use strict";

/**
 * Checks adopt-example/records.js: the decision records in a LangGraph BaseStore.
 *
 *   node records-test.js
 */

const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { recordStore } = require(path.join(ADOPT, "records"));
const { InMemoryStore } = require(path.join(ADOPT, "node_modules", "@langchain/langgraph"));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(68)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}

(async () => {
  const base = new InMemoryStore();
  const s = recordStore(base);
  const key = "user:schedule_pickup:thread.1";
  await s.persist(key, { n: 1, execution_decision: "hold" });
  await s.persist("user:schedule_pickup:thread", { n: 9, execution_decision: "executed" });
  await s.persist(key, { n: 2, execution_decision: "executed" });
  await s.persist(key, { n: 3, execution_decision: "ask_user" });
  check("a key with ':' and '.': every record under it, oldest first", (await s.list(key)).map(r => r.n), [1, 2, 3]);
  check("  load is the latest that executed", (await s.load(key))?.n, 2);
  check("  another key, and an unknown one, are kept apart", [(await s.list("user:schedule_pickup:thread")).map(r => r.n), await s.list("absent"), await s.load("absent")], [[9], [], null]);

  const many = recordStore(new InMemoryStore());
  for (let i = 0; i < 250; i++) await many.persist("k", { n: i });
  const got = (await many.list("k")).map(r => r.n);
  check("250 records written at once: all of them, in the order written", [got.length, got.every((n, i) => n === i)], [250, true]);

  const steps = recordStore(base, "steps");
  await steps.persist(key, { k: 0 });
  check("another area of the same store: kept apart from the records", [(await steps.list(key)).length, (await s.list(key)).length], [1, 3]);
  const items = await base.search(["preflight", "records"], { limit: 100 });
  check("  where they are: ['preflight', 'records', <the key, encoded>], never overwritten",
    [items.every(it => it.namespace[0] === "preflight" && it.namespace[1] === "records" && !/[:.]/.test(it.namespace[2])), new Set(items.map(it => it.key)).size === items.length],
    [true, true]);
  let err = null;
  try { recordStore({}); } catch (e) { err = e.message; }
  check("not a BaseStore: refused", /BaseStore is required/.test(err ?? ""), true);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e); process.exit(1); });
