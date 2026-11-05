"use strict";

/**
 * The gate in a LangGraph graph. The skeleton is used as it is: runPreflight judges, the graph runs
 * the flow.
 *
 *   START → gate ─ execute ─→ execute → END
 *             │
 *             ├─ ask_user ─→ ask ─ accept ─→ gate        (decline / cancel → END)
 *             └─ anything else (hold, definition_repair, exhausted, …) → END
 *
 * Who does what:
 *   the graph     when to ask, how, how often, where to stop and when to resume (interrupt,
 *                 Command({ resume }), a checkpointer). None of this is the skeleton's.
 *   the gate      runPreflight, unchanged. Each round it is given everything collected so far and
 *                 judges again from scratch. An answer the graph collected enters as userAnswers and
 *                 is looked up as user_answer (spec 4.6): the graph never marks a slot settled.
 *   the ask node  asks for exactly what the gate listed, no more and no less (4.6). Its request has
 *                 the shape of an MCP elicitation (mode, message, requestedSchema), and its resume value
 *                 the shape of the reply (action, content). A value the model proposed goes in as the
 *                 field's default; what comes back in content is what the seller submitted, so the
 *                 value executed is the value the seller saw and sent.
 *   execute       calls the tool with the gate's call_arguments, never with anything else.
 */

const { StateGraph, Annotation, interrupt, MemorySaver, START, END } = require("@langchain/langgraph");
const { createPreflight } = require("../execution-state-preflight");
const { createHooks, createStorage } = require("./hooks");
const TOOL = require("./tool.json");

const last = (a, b) => (b === undefined ? a : b);
const merge = (a, b) => ({ ...(a ?? {}), ...(b ?? {}) });

const State = Annotation.Root({
  // Fixed for the run: the user turn, what the platform measured, the seller's checklist.
  segments: Annotation({ reducer: last, default: () => [] }),
  measuredData: Annotation({ reducer: last, default: () => ({}) }),
  userChecklist: Annotation({ reducer: last, default: () => [] }),
  // Values a model proposed for the seller to confirm. Shown as defaults; they settle nothing.
  proposals: Annotation({ reducer: last, default: () => ({}) }),
  // What the seller submitted, accumulated across asks.
  userAnswers: Annotation({ reducer: merge, default: () => ({}) }),
  checklistAnswers: Annotation({ reducer: merge, default: () => ({}) }),
  asks: Annotation({ reducer: last, default: () => 0 }),
  verdict: Annotation({ reducer: last, default: () => null }),
  ended: Annotation({ reducer: last, default: () => null }),
  executedWith: Annotation({ reducer: last, default: () => null }),
});

const CHECK_PREFIX = "confirm__";

// The elicitation request for what the gate listed. Field schemas are the tool's own, without its x-
//   keywords (elicitation takes a flat object of primitive fields). An item the seller must confirm
//   becomes a yes/no field.
function elicitationFor(verdict, tool, proposals) {
  const props = {};
  for (const name of verdict.askFields) {
    const p = tool.inputSchema?.properties?.[name] ?? { type: "string" };
    props[name] = {
      type: p.type ?? "string",
      ...(p.format ? { format: p.format } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
      ...(proposals?.[name] !== undefined ? { default: proposals[name] } : {}),
    };
  }
  for (const item of verdict.askItems) {
    props[CHECK_PREFIX + item.id] = { type: "boolean", title: item.id, description: `Does this hold: "${item.description}"?` };
  }
  return {
    mode: "form",
    message: `Before ${tool.name} can run, please provide: ${Object.keys(props).join(", ")}`,
    requestedSchema: { type: "object", properties: props, required: Object.keys(props) },
  };
}

// The elicitation reply as JSON Schema: an action, and content in the shape the request asked for.
function replySchemaFor(request) {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["accept", "decline", "cancel"] },
      content: request.requestedSchema,
    },
    required: ["action"],
  };
}

// Keeps only what was asked for, of the type asked for. A key the request did not name is dropped, so
//   a reply cannot add an argument the gate did not ask the seller for. The format is not checked here:
//   the gate checks it, and asks again if it fails.
function acceptContent(request, content) {
  const answers = {}, checklist = {};
  for (const [key, schema] of Object.entries(request.requestedSchema.properties)) {
    if (!content || !(key in content)) continue;
    const v = content[key];
    if (schema.type === "boolean") {
      if (typeof v === "boolean") checklist[key.slice(CHECK_PREFIX.length)] = v;
    } else if (typeof v === "string" && v.trim() !== "") {
      answers[key] = v;
    }
  }
  return { answers, checklist };
}

/**
 * @param ask       the model call for the hooks (a stub in the tests)
 * @param callTool  (name, args) → result. The tool itself.
 */
function buildGraph({ ask, callTool, tool = TOOL, confirmed, checkpointer = new MemorySaver(), runId = "graph" }) {
  let round = 0;

  async function gate(state) {
    round += 1;
    const hooks = createHooks({ ask, runId: `${runId}-${round}`, tool, measuredData: state.measuredData, ...(confirmed ? { confirmed } : {}) });
    const preflight = createPreflight({ hooks, storage: createStorage() });
    const st = await preflight.runPreflight({
      userId: "seller_1", instruction: state.segments, mcpTool: tool, preSetData: {},
      measured_data: state.measuredData, userChecklist: state.userChecklist,
      userAnswers: state.userAnswers, checklistAnswers: state.checklistAnswers,
      intent_attempt: 0, tool_attempt: 0, ask_attempt: state.asks,
    });
    await preflight.recordExecutionState(st);
    return { verdict: {
      decision: st.execution_decision,
      reason: st.reason,
      call_arguments: st.execution_decision === "execute" ? st.call_arguments : null,
      // The blanks on the ask route, from the gate's own field records — not re-derived here.
      askFields: (st.fields ?? []).filter(f => f.status === "unknown" && f.route === "ask_user").map(f => f.name),
      askItems: (st.gate?.unverified_checklist ?? []).map(i => ({ id: i.id, description: i.description })),
      fields: (st.fields ?? []).map(f => ({ name: f.name, status: f.status, source: f.source ?? null, route: f.route ?? null })),
      user_checklist: (st.user_checklist ?? []).map(i => ({ id: i.id, status: i.status, source: i.source ?? null })),
    } };
  }

  function askNode(state) {
    // Runs again from the top on resume (LangGraph re-executes the node), so everything before
    //   interrupt() is a pure function of the state.
    const request = elicitationFor(state.verdict, tool, state.proposals);
    // The reply's shape also goes in LangGraph's own slot for it (responseSchema), so a client finds the
    //   form at Interrupt.response_schema. A JSON Schema there is passed through, not enforced: whether
    //   the answer counts stays with the gate, so a failed answer is recorded and counted toward the
    //   ceiling instead of ending the run as a validation error.
    const reply = interrupt(request, { responseSchema: replySchemaFor(request) });
    if (reply?.action !== "accept") return { ended: reply?.action === "decline" ? "declined" : "cancelled" };
    const { answers, checklist } = acceptContent(request, reply.content);
    return { userAnswers: answers, checklistAnswers: checklist, asks: state.asks + 1 };
  }

  async function execute(state) {
    const args = state.verdict.call_arguments;
    await callTool(tool.name, args);
    return { ended: "executed", executedWith: args };
  }

  return new StateGraph(State)
    .addNode("gate", gate)
    .addNode("ask", askNode)
    .addNode("execute", execute)
    .addEdge(START, "gate")
    .addConditionalEdges("gate", s => {
      if (s.verdict.decision === "execute") return "execute";
      if (s.verdict.decision === "ask_user" && (s.verdict.askFields.length + s.verdict.askItems.length) > 0) return "ask";
      return END;
    }, ["execute", "ask", END])
    .addConditionalEdges("ask", s => (s.ended ? END : "gate"), ["gate", END])
    .addEdge("execute", END)
    .compile({ checkpointer });
}

module.exports = { buildGraph, elicitationFor, replySchemaFor, acceptContent, State, CHECK_PREFIX };
