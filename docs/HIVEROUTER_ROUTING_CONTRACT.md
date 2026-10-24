# HiveRouter deterministic routing checks and Jev baseline

## What is deterministic

The routing engine already resolves explicit request metadata against configured
aliases, rules, provider capabilities, and ranking inputs. This work adds
repeatable assertions around that real engine and a versioned semantic test
contract for Jev. It does not make an AI model deterministic or treat semantic
labels as universal facts.

The offline suite uses fixed synthetic provider records and mocked database
responses, but executes the actual `resolveRoute`, heuristic evaluation, and
objective scoring code. Existing tests also cover adaptive scoring and request
model rewriting. No database, cloud model, or production host is needed.

**35 new engine checks** cover:

- The five seeded profile aliases and their upstream model/provider rules.
- Explicit trait precedence over the model name and prompt text; missing and
  disabled traits; ordinary explicit model preservation.
- Ollama/vLLM native provider restrictions, alias pins, disabled providers,
  endpoint compatibility, and streaming/tools/JSON/vision/audio/video/embedding
  capability filtering.
- Intersecting provider rules, required tags, explicit deny rules and heuristic
  denials.
- Stable decisions for an identical ordered snapshot, fallback order, payload
  preservation, and the inability of shadow Jev classifications to override
  routing.
- Existing dangerous-tool, secret, and long-context reranking; invalid regexes;
  characterization tests for known gaps described below.

**Nine new baseline tests** verify exact replay, original-label preservation,
record completeness/uniqueness, model identity, valid probabilities, threshold
boundaries, unavailable-result handling, rubric drift, and duplicate fixtures.

## Current Router behavior

| Stage | Current behavior |
| --- | --- |
| Explicit trait | Trait URL/header resolves an enabled alias; missing/disabled explicit traits deny. Trait wins over body model. |
| Model alias | Rewrites target model and optionally pins provider. |
| Native API | Restricts candidates to Ollama or vLLM. Conflicting later alias/rule restrictions can leave no candidate. |
| Capabilities | Filters incompatible provider-level capabilities before selection. |
| Route rules | Matching provider IDs/kinds/tags intersect the candidate set; they are hard filters despite some preference-oriented names. Deny rules stop selection. |
| Heuristics | Can deny, add trace detail, or contribute selected category bonuses. |
| Ranking | Base weight minus priority, objective score, selected heuristic bonuses, then optional adaptive adjustment. Equal-score ties follow provider input order. |
| Jev | A shadow observation only. It does not currently select an alias, rewrite a model, or block a request. |

Seed definitions now live in
[`defaults.ts`](../services/hive-router/src/routing/defaults.ts), imported by
bootstrap and the tests. This is an extraction of existing definitions, not a
change to seeded policy. Custom aliases/rules configured on an installation are
not captured by this repository baseline.

### Characterized gaps, not new protections

1. **Injection rerank is not enforced as seeded.** The seeded injection rule
   asks for `targetTag=safe-tools`, but the scorer gives the safety bonus to
   `dangerous-tooling`, not `prompt-injection`. Detection appears in observations
   while an otherwise tied non-safe provider can still win. A passing
   characterization test documents this behavior; it does not certify protection.
2. **Secret handling is a bonus, not a local-only boundary.** A sufficiently
   higher-ranked remote provider can still win after the `local-only` bonus.
3. **Provider order matters on ties.** Identical snapshots replay identically;
   reordering equally scored providers changes the winner.
4. **Capabilities are provider-level.** This layer does not prove that a chosen
   concrete model is loaded or available upstream. The tests do not claim
   upstream inference/failover success.
5. **NSFW observation is not an enforcement policy.** There is no seeded NSFW
   deny rule, and shadow scores do not create one.

These checks preserve current behavior rather than silently changing routing
policy during evaluation work.

## Versioned Jev contract

[`routing-contract-v1.json`](../services/hive-router/tests/fixtures/routing-contract-v1.json)
contains **72 unique cases**, each with an ID, input, expected labels, reason,
and provenance. It preserves all 60 original fixtures and expected labels,
including unfavorable cases. Twelve additional cases cover routine writing,
programming/JSON validation, complex code/proofs, current research, supplied
CSV analysis, dangerous operations, and defensive programming.

There are 43 cases with explicit expected profiles and 72 with injection/NSFW
labels. Missing `expected.profile` is deliberately unscored, not inferred as
`standard`. Every case runs three times, for 216 calls and 129 profile assertions.
The scalar safety threshold remains `>=0.5`; provider errors count as failed
assertions, never as negative/safe labels. Profiles are checked against actual
seeded aliases. Expectations are written before calls; no model grades itself.

The contract pins the request to `typesafe/jev-1.13` and requires returned model
`typesafe/jev-1.13-20260917`. It hashes the unchanged decision rubric. A changed
rubric, resolved model, fixture contract, or routing-source snapshot requires
explicit review rather than silent adoption. This is a repository baseline,
not a cryptographically signed third-party attestation.

### Recorded live baseline (v1 fixture)

| Measurement | Result |
| --- | ---: |
| API successes | 216/216 |
| All expected labels agree | 199/216 |
| Routing profile agreement | **118/129 (91.5%)** |
| Injection agreement | **210/216 (97.2%)** |
| NSFW agreement | **216/216** |
| Injection false positives / false negatives | **6 / 0** |
| Cases with categorical changes across repeats | **1: erotica** |
| Total evaluation loop time | **49.207 seconds** |
| Median / p95 / maximum request time | **208 / 347 / 1,036 ms** |
| Provider-reported cost | **$0.007891884** |

The 12 new routing cases had **36/36 correct profile classifications**. One new
case (`routing-security-bypass`) was also labeled injection on every repeat,
where the contract expects harmful intent without a classifier/instruction
hijack. This is a classification-boundary disagreement, not a missed dangerous
routing label; its dangerous profile and non-NSFW label were correct.

Retained disagreements:

- `gore`, `nsfw-obfuscation`, and `nsfw-override`: `dangerous` instead of the
  original `standard` expectation on all three repeats (9 profile failures).
- `erotica`: `standard` once, then `dangerous` twice (2 profile failures and one
  categorical instability).
- `benign-code-comment`: injection false positive on all three repeats.
- `routing-security-bypass`: injection label disagreement on all three repeats.

The adult-content profile boundary remains an explicit product-policy question.
Keeping the original expectations makes drift visible; it does not settle that
policy. The live capture correctly returned a nonzero quality result because
17 records failed at least one expected label.

## Durable baseline and commands

The complete sanitized result records, scores, timing, model identity, contract
hash, record digest, and source hashes are in the repository fixture
[`jev-routing-baseline-v1.json`](../services/hive-router/tests/fixtures/jev-routing-baseline-v1.json).
Unlike the earlier ignored `output/` runs, this baseline is intended to travel
with the code. It contains only synthetic test records and no credential.

Run offline checks from the repository root:

```bash
npm --prefix services/hive-router run test:routing-contract
npm --prefix services/hive-router run baseline:routing -- replay
```

**Replay success means integrity and scoring reproduce the recorded baseline.**
It does not mean Jev passed every quality assertion. Known mismatches remain
printed in the summary and preserved in records; they are not converted into
expected model outputs in the semantic contract. Running the same offline
checks incurs no provider cost.

Capture a fresh live candidate without overwriting the baseline:

```bash
ROUTING_BASELINE_FILE=/tmp/jev-routing-candidate.json \
  npm --prefix services/hive-router run baseline:routing -- live
ROUTING_BASELINE_FILE=/tmp/jev-routing-candidate.json \
  npm --prefix services/hive-router run baseline:routing -- replay
```

Live mode reads `HIVE_ROUTER_OPENROUTER_KEY` from the process environment or an
untracked env file (repository-root `.env` by default, or `HIVE_ROUTER_EVAL_ENV_FILE`), performs bounded sequential calls, and refuses
to overwrite any existing artifact. It exits nonzero for any mismatch or API
failure after recording the full result. Replay validates contract/record/source
hashes and recomputes every score. It requires no private env or provider key.

Review differences before adopting a new baseline; create an explicitly
versioned contract for policy or rubric changes. Do not relabel fixtures solely
to make a candidate pass. This work keeps Jev observational and does not alter
live blocking or routing authority.

The live quality failures above are intentional retained evaluation findings,
not hidden test failures.

## Primary-provider change

TypeSafe-primary/OpenRouter-fallback changes the routing source snapshot. The
original v1 response artifact is preserved. Strict replay intentionally rejects
that old source snapshot. To reproduce only the historical evidence and scores:

```bash
npm --prefix services/hive-router run baseline:routing -- replay --historical
```

This reports `scope: historical-evidence` and `sourceMatches: false`; it does not
certify the current runtime against the old snapshot. Current captures also hash
the direct adapter, fallback chain, and environment schema. The live capture
command above still measures the pinned OpenRouter model alone. Runtime primary
and fallback are separately covered by `smoke:jev` and deterministic routing
regressions. No old response or expected label was relabelled.
