# Promise/duty graph runtime

LightningLoop uses bounded directed graphs rather than a hard-coded linear agent loop. The implementation is `Harness/graph/promise-graph.ts`.

Every node declares:

- `duty`: what the role is accountable for;
- `requires`: named promises that must already exist;
- `provides`: every named promise the node must publish on every route;
- `transitions`: explicit named routes;
- `maxVisits`: a local cycle bound.

Every graph also declares `maxSteps`. Missing promises, omitted or undeclared outputs/routes, missing handlers/targets, visit exhaustion, or total-step exhaustion fail closed. Handler contexts contain cloned promise values, so a role cannot mutate a snapshot and forge downstream state. The runtime records node, duty, visit, route, promises, and evidence in a graph trace.

## Criterion evidence contract

The planner must declare `evidence_kind` and `evidence_target` for every criterion. The parser accepts only these explicit kinds; reviewer-facing prose is never scanned for magic words. For every non-`source`/non-`user_acceptance` kind, planner-supplied `title`, `detail`, and `evidence` must exactly equal the harness-owned template derived from that kind and target. A mismatch is rejected rather than silently rewritten, so substantive or factual claims cannot hide in a narrow implementation predicate:

| Kind | Exact target | Automatic Gold boundary |
|---|---|---|
| `source` | opened HTTPS URL | supplementary context only: exact URL, routing class, hash-preserved body, excerpt, planner-selected claim, and matching deliverable cannot independently establish factual truth or automatic Gold; the objective pauses for owner acceptance |
| `behavior` | `js-export:<path>#<export>=<JSON scalar>` | supplementary only: the isolated VM imports the exact export without host `process`/filesystem bindings and records the result, but the planner selected the expected scalar, so it is not an independent correctness oracle and never satisfies automatic Gold; use `user_acceptance` until a fixed harness-owned predicate registry exists |
| `build` | currently `build:cargo` | reserved and supplementary only; the deterministic no-fork verifier rejects Cargo today, so this kind cannot satisfy automatic Gold and pauses rather than approving |
| `syntax` | harness assertion such as `syntax:app.js` | supplementary only: a harness-selected parser can prove syntax, but cannot prove objective sufficiency |
| `file` | exact relative path | supplementary existence/integrity evidence only; a hash cannot prove truth, behavior, usefulness, or automatic Gold |
| `render` | exact relative source path | supplementary only: a generated preview is hash-bound and attached to an image-capable reviewer call, but cannot self-award Gold |
| `user_acceptance` | named acceptance boundary | never passes automatically; the graph pauses for the user |

The model's deliverable text is catalogued as unverified and cannot independently satisfy any kind. A source or reference image is input, not output proof. A passing syntax check cannot satisfy behavior. All verification commands are compared against pre-execution workspace hashes and rejected if they mutate tested files; only the pinned photo-relief workflow has an explicit `generate` mode, after which outputs are independently audited and hashed. These are deterministic harness comparisons performed after the independent reviewer cites evidence IDs.

Planner-authored criteria are not an independent contract for the user's objective. No factual/source, artifact, behavior, build, syntax, render, or general semantic criterion can currently award automatic Gold. Even a `.gov`, `.edu`, or explicitly allowlisted source is only a routing candidate: the planner selected the claim and the harness has no immutable truth oracle. Deterministic checks and harsh review still collect falsifiable evidence, but the graph pauses at the owner-acceptance boundary instead of converting that evidence into a truth verdict.

Current graphs are hybrid and deterministic in shape while model work remains dynamic:

```text
plan.draft -> review-plan -> approved
                  | revise
                  v
              repair-plan --repaired--> review-plan

implementation.draft + plan.approved -> verify-review -> gold
                                           | revise
                                           v
                                  repair-implementation --repaired--> verify-review
```

“Promises” are typed commitments between autonomous roles, inspired by Promise Theory; they are not JavaScript `Promise` objects. AWS's agentic workflow guidance supports graph-shaped orchestration with dependency-aware static, dynamic, or hybrid routing. Sources: <https://markburgess.org/BookOfPromises.pdf>, <https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf05-bp01.html>.

Graph changes belong in the managed overlay only after source review, sandbox tests, adversarial review, user approval, and a rollback snapshot. Do not grant tools or permissions merely because a graph requests them.
