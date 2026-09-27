# Call Copilot - Talk Track

## Per-phase presenter script

- **Consent:** "Every call this tool touches starts with an explicit consent announcement - that's not a feature we bolted on, it's the first thing that has to happen before a single audio byte is captured."
- **Discovery:** "Right now the SE and prospect are just talking. Nothing lights up until the copilot recognizes something worth surfacing - it's not narrating the whole call."
- **Question trigger:** "There's a direct question. Watch the diagram: the trigger detector fires, TiDB runs a vector query and a full-text query at the same time, fuses them, and Claude Haiku streams a suggestion, all inside about two seconds."
- **Competitor trigger:** "The prospect just named a competitor. The retrieval scope automatically shifts toward battlecard content, same database, same query shape, different rows come back on top."
- **Objection trigger:** "This is the objection that trips up newer SEs. The copilot has the honest, pre-written answer ready before the SE has to think of one."
- **Technical trigger:** "A technical term surfaces a documentation-grounded fact, not an improvised explanation."
- **Wrap-up:** "When the call ends, Claude Sonnet writes the summary and follow-up draft straight back into the same TiDB database the facts came from."

## Discovery questions (for a real conversation about this tool)

1. "Walk me through what your SEs currently do to find the right proof point mid-call - is it memory, a shared doc, or messaging a teammate?"
2. "How many live product or competitive calls does your SE team run in a typical week?"
3. "If a suggestion showed up two seconds late, would that still be useful, or does it need to be closer to instant?"
4. "Who owns the knowledge base this would draw from today - is it centralized or scattered across docs, chat, and tribal knowledge?"
5. "What's your policy today on recording and retaining call audio or transcripts?"

## Objections and honest answers

1. **"This just sounds like a wrapper around an LLM."** Partly true - the value here isn't the LLM call, it's that retrieval is grounded in a single database doing both semantic and keyword search fast enough to matter mid-call, with a measured eval set proving hybrid beats either mode alone rather than assuming it.
2. **"Won't this just tell the SE to say something wrong?"** It can, which is why every suggestion draws only from the facts retrieval actually returned, and the prompt is explicit: if no facts are retrieved, say so plainly rather than guessing.
3. **"What about compliance or legal risk from recording calls?"** This demo requires an explicit consent step before capture, never stores raw audio, redacts PII from transcripts before they reach any LLM, and purges transcripts after a configurable retention window - it does not replace your own legal review of call-recording law in your jurisdictions.
4. **"Doesn't a human SE already know all this?"** Experienced SEs do; the tool's real value is ramping newer SEs and covering the "objection you get once a quarter and always fumble" case, not replacing expertise.
5. **"Isn't this just a narrower version of a broader after-call assistant?"** Yes, deliberately - a broader after-the-fact retrieval assistant (pre-call research, post-call coaching, follow-up drafting) is a different, larger surface. This demo narrows to the live, in-call moment: streaming ASR, a sub-few-second trigger-to-suggestion latency budget, and a labeled retrieval eval set, built on this repository's shared lab platform so it can be recorded and replayed on the demo site.
