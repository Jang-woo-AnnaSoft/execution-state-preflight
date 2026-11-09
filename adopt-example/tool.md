# Example: a tool's definition, as its provider declares it

This is the definition of a tool as its provider declares it: its name, its description with the
rules in words, and its input schema.

- **You build the agent and the tool together** (the default here). You are the tool's provider, and
  this file is your declaration. The agent's model and the gate read the tool from it, on every run
  (`TOOLS_FILE`, default this file). Build the tool from the same declaration, and connect it in
  `connect.js` (`TOOLS`).
- **The tool is someone else's, on an MCP server.** Its provider registers it there with this name,
  description and input schema. `connect.js` keeps the MCP connection as comments: uncomment it, and the
  gate reads the definition from the server's list instead.

The tests run this same tool, from
[`provider-checklist-example/tool.json`](../provider-checklist-example/tool.json), and check that the
two match.

## Name

```text
schedule_pickup
```

## Description

What the tool does, then each rule on a line of its own, starting with its label. Say what the value
is and who gives it, or what must hold. A line need not say how to ask: the model asks, and code holds
the answer to what was shown.

```text
Schedule an in-person pickup for a marketplace item. The buyer sees it at once. Times are in the time zone of the seller's account region.
[Required] The sale must be agreed, as shown by the order status. Only the status "agreed" means agreed.
[Required] The listing must be the seller's own, as shown by the listing's owner on the platform.
[Verify] The item is the listing the seller names.
[Verify] The time is the one the seller states, or the time of a pickup request the buyer sent in the app inside a range the seller set for this pickup. It is one moment.
[Verify] The location is the place the seller names.
[Required] The buyer's contact is read from the platform.
[Notice] The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled.
```

- `[Required]` must hold, and is confirmed only from the system's own data. A value only the system
  gives is a `[Required]` line too ("read from the platform").
- `[Verify]` is the user's. A value only the user gives is a `[Verify]` line: a value from anywhere
  else counts only once the user approves it.
- `[Notice]` is shown to the user and blocks nothing.

## Input schema

Forms only: each value's type, its format or pattern, and which values are required. No descriptions
and no rules; those are lines of the description.

```json
{
  "type": "object",
  "properties": {
    "item_id": {
      "type": "string",
      "pattern": "^LST-\\d{4}$"
    },
    "time": {
      "type": "string",
      "format": "date-time"
    },
    "location": {
      "type": "string"
    },
    "buyer_contact": {
      "type": "string"
    }
  },
  "required": [
    "item_id",
    "time",
    "location",
    "buyer_contact"
  ]
}
```

## What the agent's side needs for it

The lines name what the system must be able to read. In [`connect.js`](./connect.js), `MEASUREMENTS`
connects them, each read for the listing the gate settled:

| Line | Measurement |
|---|---|
| The sale must be agreed | `order_status` |
| The listing must be the seller's own | `listing_owned_by_seller` |
| The time … a pickup request the buyer sent in the app | `time` |
| The buyer's contact is read from the platform | `buyer_contact` |

Until they are connected, the `[Required]` lines are unverified and nothing runs.
