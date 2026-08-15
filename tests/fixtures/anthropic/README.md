# Anthropic API fixtures — SYNTHETIC, not captured

Every other fixture directory here holds bodies captured from a live service.
These do not, and cannot: there is **no Anthropic credential on this machine**,
and M5 task 2 was explicitly forbidden from obtaining one. Calling the real API
to capture a response would itself be the spend the whole task exists to make
impossible.

So these files are hand-written against the **documented** `POST /v1/messages`
response shape (`id`, `type`, `role`, `model`, `content[]`, `stop_reason`,
`usage.input_tokens`, `usage.output_tokens`). They are the one place in this
tree where a fixture is not evidence about a real service — which is stated
here rather than left for someone to discover.

**What that means for the tests that read them.** They prove the parser handles
the documented shape, the status-code classification, and the cost arithmetic.
They do **not** prove the shape is right. The first real call is what does
that, and if it disagrees, these files are wrong and the parser follows them.
The mitigation is the parser's own strictness: a 200 whose body is not this
shape reports `malformed_response` rather than an empty completion, so a wrong
guess here surfaces loudly instead of storing `''` against an append-only
corpus forever.

`stop_reason: "refusal"` (in `messages-200-refusal.json`) is the one worth
reading before editing: it is a **200 with an empty `content` array**, which is
why the parser distinguishes "no `content` key at all" (malformed) from "a
`content` array with no text blocks" (a real, empty answer).
