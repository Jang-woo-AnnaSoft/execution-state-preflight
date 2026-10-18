# Meta Muse on Facebook Marketplace: a pickup nobody confirmed

A short case report. It keeps three things apart: what was reported, what the proposed check is designed to do, and what has actually been tested. So far, nothing has been tested on this case (see section 4).

## 1. Scenario (as reported)

In September 2026, Matt Robb, a Facebook Marketplace seller, put Meta's Muse agent in charge of a listing: a Logitech MX Keys Mini, asking CA$15. When Muse asked for permission to handle his Marketplace messages, he chose "Allow Always." He had entered his building's address as the pickup location, and he reportedly gave Muse negotiation parameters. Those parameters have not been published.

He says he expected Muse to come back to him before accepting an offer or setting up a pickup.

## 2. Failure (as reported)

Reconstructed by press from Robb's screenshots, on September 26:

- 5:27 p.m. Muse told a buyer the item was pickup only and gave the building's address.
- The buyer proposed 8 to 10 p.m. Muse agreed to that window and to a CA$10 e-transfer.
- About 9:15 p.m. The buyer arrived. Robb was not home and did not know anyone was coming.
- 9:27 p.m. An automatic reply in Robb's name said "Yep I'm here!"
- 9:38 p.m. The buyer left and later posted a negative rating.
- 10:27 p.m. Muse apologized to the buyer in Robb's voice: "got tied up and missed you completely."
- About 10:28 p.m. Muse told Robb, around 50 minutes after the buyer had left.

Meta's response: a Muse team lead said that earlier investigations found Muse "following direct instructions and correctly asked for permission." Meta has also said, "The goal is not to ask the user about everything."

All of this comes from Robb's posts and screenshots as reported by the press. I have not seen the original logs, and the buyer's account is not public.

**My reading (interpretation, not observation):** permission was not what was missing. Muse had permission to send messages. What it lacked was a source for several things it said on Robb's behalf:

- that he was available that evening
- that he agreed to a specific window
- that he was at the door

Nobody gave those values. The model filled them in, and permission let them through.

One more thing: there was one delegation, but many executions. The address, the time window, the price, the "I'm here" reply, the apology. Robb handed over a single listing, and that one delegation produced several commitments and statements in his name. The apology after the buyer left wasn't even part of selling. It was a new execution, made to clean up a failure.

## 3. Proposed check

[Execution-state preflight](https://github.com/Jang-woo-AnnaSoft/execution-state-preflight) is a specification for a gate in front of irreversible execution. A sent message counts as irreversible, because the recipient may already have read it.

It changes the default from "runs unless prohibited" to "runs only when everything required is confirmed, within the scope the user stated or approved." The model points to where each value is supposed to come from. The gate then looks the value up in a declared source: what the user said, settings the user approved in advance, or a live system measurement. A value found in none of them stays UNKNOWN. While anything is UNKNOWN, the execution is not executable, and the item goes to whoever can fill it.

Applied to the reported sequence, assuming the tool declares each committing message as an execution unit with these slots:

| Message | What it commits to | Source available | Gate outcome |
|---|---|---|---|
| Address at 5:27 p.m. | Pickup location | Yes. Robb entered it and approved the template | Passes on the value. See limitations |
| Agreeing to 8–10 p.m. | Seller available in that window | None. Robb never stated availability | UNKNOWN. Robb is asked before anything is sent |
| CA$10 | Price within his limits | Depends on the unpublished parameters | KNOWN if a declared floor covers it, otherwise asked |
| "Yep I'm here!" | Seller is present | None | UNKNOWN. Not sent |
| "Got tied up" apology | A reason for the no-show | None | UNKNOWN. Not sent |

The spec doesn't put one gate on a delegation. It puts one gate on each state change left outside (spec 1.1). So even with "handle my messages" delegated, each message that commits to something needs its own grounds. Whatever is done after an execution is blocked or fails is not a continuation of it but a new execution unit. The apology after the buyer left is one. If it isn't within what the user stated or approved, it isn't attempted.

Under the spec, a stop like this is not a failure. The unconfirmed item goes to Robb at 5:27 p.m., before any commitment is made. The run is recorded with its reason, and it is not finished some other way.

## 4. Scope and limitations

**What the check can establish.** Every value in a sent commitment has a source that the gate looked up itself, not one the model labeled. A value with no source does not go out.

**What it would not have caught:**

- The address. It had a legitimate source and an approved template. Holding it until a pickup is confirmed is a condition someone has to declare: Meta as the tool provider, or Robb as the user. The spec does not invent conditions that nobody declared.
- Robb's expectation that he would be asked before any offer was accepted. He never declared it. After the incident he told Muse, "don't agree to pickup unless you check with me." That is exactly a user checklist item, but it came after the fact.
- What counts as an execution unit. If the tool declares only "send message" and no slots for time, price, or presence, the gate has nothing to check. Undeclared state changes are out of reach (spec 1.1).
- Tool and intent matching. Whether "handle my messages" covers apologizing on his behalf can be compared against the declared scope, but not proven in code (spec 8.1).
- How Robb gets told. The spec ends at the decision record. Notification is outside it.

**What has been validated: nothing on this case.** What exists is the specification and a JavaScript reference skeleton. I have not reproduced this message sequence with the skeleton, I have no access to Muse, and there are no benchmark results. Everything in section 3 describes what the design is meant to do, not observed behavior.

A useful next step would be to turn the reported message log into a test case and run it through the skeleton. Comments on the slot mapping in the table are welcome, especially from anyone who thinks one of those rows is wrong.

## Links

- Specification: <https://github.com/Jang-woo-AnnaSoft/execution-state-preflight/blob/main/spec.en.md>
- Repository (spec, design notes, reference skeleton): <https://github.com/Jang-woo-AnnaSoft/execution-state-preflight>

## Sources

- [Xenospectrum: Meta Muse, address disclosure and approval scope](https://xenospectrum.com/en/meta-muse-address-approval-scope/) (timeline and Meta statements)
- [Dexerto: Meta responds after Muse AI gave a stranger a YouTuber's home address](https://www.dexerto.com/youtube/meta-responds-after-muse-ai-gave-stranger-youtubers-home-address-on-facebook-marketplace-3414057/)
- [Business Today: Meta Muse AI allegedly shared user's address](https://www.businesstoday.in/technology/artificial-intelligence/story/meta-muse-ai-allegedly-shared-users-address-finalised-a-sale-deal-without-approval-buyer-showed-up-at-915-pm-558264-2026-09-28)
- [Malwarebytes: Meta's Muse sent a Facebook Marketplace buyer to a seller's home](https://www.malwarebytes.com/blog/news/2026/09/metas-muse-sent-a-facebook-marketplace-buyer-to-a-sellers-home)
