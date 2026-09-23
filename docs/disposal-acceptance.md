# Consumer disposal — acceptance matrix

Spec §7.1. One row per acceptance criterion, with the evidence that exists **today**.
A criterion is only marked proven when there is a concrete artefact to point at: a
named test, or a browser action whose write was confirmed in the database. Everything
else says so, because an acceptance record that overstates is worse than none.

Legend

- **proven** — a named test or a browser action with a database-confirmed write.
- **implemented, unproven** — the code path exists and is described, but nothing
  executes it in a way that would fail if it broke.
- **not built** — no code path.

## Proven

| #   | Criterion                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | A potential match produces no actionable task and no permission                                     | `tests/disposal-service.integration.test.ts` — seeds every product unconfirmed and asserts the authorization is refused with `ELIGIBILITY_NOT_CONFIRMED`; `tests/disposal-policy.test.ts` — blocks a task whose eligibility is `pending_confirmation`. Browser: the panel showed eligibility as _Awaiting confirmation_ with the product unconfirmed.                                                                                                                                                                                                                                           |
| D02 | Confirmed and applicable shows the right products, quantity and version                             | Browser: panel showed _Confirmed affected_, instructions `v1`, one product row `Qty 1`. `tests/disposal-submit.integration.test.ts` asserts the task is seeded from the submitted products.                                                                                                                                                                                                                                                                                                                                                                                                     |
| D04 | No approved, authorizing instruction ⇒ no permission, and no improvised method shown                | `tests/disposal-submit.integration.test.ts` — no task is opened for an unapproved version, nor for one whose only approval selects a measure that is not consumer disposal. No task means the consumer is never offered a disposal step.                                                                                                                                                                                                                                                                                                                                                        |
| D05 | Approved content shows steps, examples, warnings and recognition requirements                       | Browser: rendered warning (before the steps), one numbered step, an example photo with alt text and caption, and the recognition checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D06 | An uploaded or technically verified file shows only technical progress                              | Browser: the upload control labelled the same evidence _Checking_ then _Passed our checks_, and never _accepted_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D14 | A mixed-product case only permits the confirmed, reviewed quantities                                | `disposal_authorization_items` snapshots the coverage when a permission is issued. `tests/disposal-service.integration.test.ts` — a photo accounting for two of three confirmed units yields one item of two; and accepted photos naming an unconfirmed product are refused with `No confirmed product is covered`.                                                                                                                                                                                                                                                                             |
| D15 | A withdrawn instruction stops an open page from acting                                              | `withdrawInstruction` suspends every live authorization for the version and withdraws the content. `tests/disposal-service.integration.test.ts` executes it for the first time: one authorization is suspended, the task reports `withdrawn`, the consumer view carries no instruction, and nothing new can be issued against it.                                                                                                                                                                                                                                                               |
| D13 | Closing the reportability review does not lift the disposal hold                                    | The policy input has no reportability field at all, so no review transition can lift a hold — `tests/disposal-policy.test.ts` asserts there is nothing to branch on, and that every combination of the other inputs still refuses while a hold stands.                                                                                                                                                                                                                                                                                                                                          |
| D03 | An inapplicable recall demands no declaration (server half)                                         | `tests/disposal-submit.integration.test.ts` — a submission with no approved instruction version succeeds and carries no `disposal` field at all, so the consumer surface has nothing to render a step from. **The web-app half is still unproven:** no browser run has confirmed the fall-through branch renders no declaration.                                                                                                                                                                                                                                                                |
| D08 | Accepted evidence plus every condition ⇒ a permission tied to the right version, batch and products | Browser: clicked _Issue permission to dispose_; the database then held a `disposal_authorizations` row with `status: active`. `tests/disposal-service.integration.test.ts` covers the same transition with the gate refusing before acceptance.                                                                                                                                                                                                                                                                                                                                                 |
| D09 | Replacing accepted photos re-reviews and the old permission cannot be reused                        | `tests/disposal-service.integration.test.ts` — two tests. An accepted batch **cannot be replaced at all**: the policy permits a new batch only while the latest is absent, sent back for resubmission, or already superseded, so the submission is refused and the permission stays `active` against the batch it rests on. The replacement that is allowed — a batch sent back for resubmission — is superseded by the next one rather than reviewed twice. This is a stronger guarantee than suspending the permission would have been; see the note below on why the suspension never fires. |
| D10 | Cross-user or cross-campaign access is refused                                                      | `tests/disposal-service.integration.test.ts` — a task with a valid credential of its own cannot attach another task's photo: the submission is refused with _does not belong to this disposal task_, and the target task has no batch yet, so the policy gate is not what refuses it. `tests/disposal-upload.integration.test.ts` refuses wrong-token reads and uploads; `disposal_evidence_batch_documents.document_id` is unique, so one photo cannot satisfy two reviews.                                                                                                                    |
| D11 | An invalid or expired visitor credential cannot view, continue or declare                           | `tests/disposal-service.integration.test.ts` — a token moved past `token_expires_at` is refused on all three consumer paths: the visitor read returns null, the upload is rejected, and the declaration is rejected. The task has no batch, so nothing but the credential can refuse the upload.                                                                                                                                                                                                                                                                                                |
| D12 | A hold blocks the permission even when the photos are accepted                                      | `tests/disposal-service.integration.test.ts` — accepted evidence plus a hold is refused with `DISPOSAL_ON_HOLD`. Browser: placed a hold, confirmed the row changed to _Release the hold_, then released it and saw `released_at` set.                                                                                                                                                                                                                                                                                                                                                           |
| D16 | An unauthorised person cannot review, and an administrator cannot skip the gate                     | `tests/admin-rbac.test.ts` walks **all thirteen** admin disposal routes with a `MANAGER` session and asserts a 403 from each, then asserts one denied audit row per attempt naming the actor and the role. The guards are `disposal.review` for the queue, the task read and the three decisions, `disposal.hold.manage` for placing and releasing a hold, and `disposal.instructions.publish` for the content library; every mutation also requires the audit service. `MANAGER` holds none of the three, and the refusal is the server's rather than the console hiding a control.            |
| D17 | Concurrent review, retry and duplicate declaration do not duplicate anything                        | `tests/disposal-service.integration.test.ts` — two identical submissions race on one task and leave exactly one batch, so the evidence is neither duplicated nor lost to a race that failed both. One decision per batch (`disposal_reviews_batch_uidx`), one live authorization per task and batch (partial unique index), and declarations keyed by authorization close the other three.                                                                                                                                                                                                      |
| D19 | The applicable branch cannot claim completion without a valid permission or declaration             | `tests/disposal-service.integration.test.ts` — with no live permission the task offers `disposal.declare_exception` and **not** `disposal.declare_completion`, and a completion claim carrying neither basis is refused rather than recorded. There is no control to click in the browser for that case, because the server never offers the action: the contract, the service and a database CHECK each require exactly one basis, and the service resolves the authorization itself.                                                                                                          |
| D21 | History survives an instruction update or withdrawal                                                | `tests/disposal-service.integration.test.ts` — after a withdrawal the batch, the review decision and the declaration are all still present, and the authorization is `suspended` rather than deleted. Nothing in the service deletes a decision, a batch or a declaration.                                                                                                                                                                                                                                                                                                                      |
| D24 | Every decision is attributable, and a rollback keeps history                                        | `tests/admin-rbac.test.ts` places a hold as `COMPLIANCE` and asserts the audit row it leaves: `action: disposal.hold.place`, `resourceType: disposal`, the task id, the actor's id and role, and `outcome: success`. Withdrawal suspends rather than deletes (D21). The rollback rehearsal (E3) is still outstanding.                                                                                                                                                                                                                                                                           |
| D25 | A Notice of Violation alone does not enable consumer disposal                                       | Browser: recorded `materialType: nov` with an otherwise authorizing scope and measure; the server returned `authorizesConsumerDisposal: false` and the screen said _Recorded as history. It does not authorize consumer disposal, so no task will open._ Database: the stored row is `authorizes_consumer_disposal: false` and the version it backs authorizes nothing. `tests/disposal-guards.integration.test.ts` rejects the same combination when the flag is set true.                                                                                                                     |
| D26 | A Form 332 or CBP record does not authorize consumer disposal                                       | `tests/disposal-guards.integration.test.ts` — both are refused as authorizing, and both remain storable as history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D28 | A CAP choosing return or other compensation does not force disposal                                 | `tests/disposal-service.integration.test.ts` drives submission against an approval whose measure is `consumer_return` and asserts no task is opened at all, which is the whole of the flow's gate; `tests/disposal-guards.integration.test.ts` refuses the same measure when `authorizesConsumerDisposal` is set true.                                                                                                                                                                                                                                                                          |
| D29 | A sample or import record does not imply approval for a whole series                                | `tests/disposal-guards.integration.test.ts` refuses `laboratory_report` (a sample record) and `cbp_seizure_record` (an import record) as authorizing while keeping both storable. The "whole series" half is the coverage snapshot: a permission can only cover the products confirmed as affected (D14), so no material extends it to a series.                                                                                                                                                                                                                                                |

| D07 | Missing recognition ⇒ resubmission with a reason, no permission | Browser, through the emailed link: the panel read _More photos needed_, _We need different photos before we can continue_, and _Please check the instructions above and add new ones_, with _Add photos_ / _Send for review_ / _Refresh status_ offered and `PERMISSION TO DISPOSE: Not given` — a batch sent back produces no permission. The reason itself is operator-facing: `disposal_reviews.reason_code` (`recognition_unreadable`) and the reviewer's rationale stay internal, and the consumer is pointed back at the recognition requirements rather than shown a free-text review note. |
| D18 | Evidence may be reviewed before final submission, and a visitor may safely continue | Browser, end to end: the resume URL was read **out of the queued confirmation email's payload** (`claim.confirmation.requested`), not from anywhere else. Opening it rendered the disposal page with the approved instructions. The token arrived in the fragment, was consumed, and was cleared (`location.hash` empty), leaving a session key `koi_disposal_access:<taskId>` — so a reload continues without the fragment. `tests/disposal-upload.integration.test.ts` covers the task-credentialed upload path on a submitted claim. |
| D20 | A consumer who disposed early keeps a true timeline and is not blocked | Browser, through the emailed link, with eligibility still `pending_confirmation` and no permission: the exception control was offered, _I had already disposed of it before you asked me to_ was recorded with a note, and the form was replaced by a closed task. Database: one `disposal_declarations` row with `exception_type = already_disposed_before_authorization`, `authorization_id` **null**, the note as typed, and `recorded_at` after the claim's `submitted_at`; **zero** `disposal_authorizations` rows for the task. The case stayed `submitted` — the page says so: _This does not change your claim or your remedy._ |

| D22 | Old data is not silently reclassified, and reviewed evidence is not reaped | `tests/draft-cleanup-worker.integration.test.ts` keeps expired evidence that is awaiting review and reaps only what is past its window. `tests/disposal-migrations.test.ts` reads the feature's migrations — selected by number (0017 and up) rather than by searching for the word "disposal" — and asserts they never rewrite a row, never `ALTER COLUMN` an existing one, never add a defaulted column to a table that predates the feature, and extend `evidence_category` with `ADD VALUE` rather than `RENAME VALUE`. Both failure shapes were verified by mutation: an `UPDATE` on `recall_cases`, and a defaulted boolean column, each fail the assertion meant to catch them. |

## Implemented, unproven

| #              | Criterion                                                                  | What exists                                                                             | What is missing                                                                                       |
| -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D03 (web half) | The fall-through branch renders no disposal declaration                    | The branch keys on the absence of the `disposal` field, which the server test now pins. | No browser run has submitted a claim with no disposal task and confirmed no declaration is asked for. |
| D27            | Examples never show laboratory damage and never require reproducing a test | Not applicable to code: instructions are operator content.                              | Depends on the content pack, which does not exist yet.                                                |

## Not built

| #   | Criterion                               | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D23 | Mobile capture, keyboard, screen reader | **Keyboard: verified.** Tab moves through the consumer disposal surface in DOM order and every control reached carries a visible focus indicator — links by outline, buttons by a focus ring — including all four primary actions (_Add photos_, _Send for review_, _Refresh status_, the exception control) and the file input. Focus leaves the page after the last control rather than cycling, so there is no trap. The upload cannot be driven from the in-app browser, and a **screen reader has not been used**, so that half is unverified; mobile capture is untested. |

## Found while auditing the enforcement points

D10, D11 and D16 were audited by reading their enforcement points, because each is a
criterion where "unproven" can hide "absent". All three enforce what they claim, and each
now has a test that would fail if it stopped.

**One defect turned up, in a place none of these rows covers.**
`resolutionTypeForRemedyCode` normalised a campaign remedy code to the ledger's
resolution type with `remedyCode === 'refund' ? 'refund' : 'replacement'`. Those are two
different vocabularies — a campaign names what the consumer asked for, the ledger
records how it is fulfilled, which is a payment or a shipment — so every code that was
not a refund became an expected shipment. A campaign offering `disposal_instruction`
would have produced a case waiting to post a product the consumer had been told to
dispose of, with nothing anywhere in the flow having asked about disposal. It now names
the codes this ledger can fulfil (`refund`, `replacement`, `repair`, `voucher`) and
refuses the rest as a 422 instead of classifying them; `tests/resolution-mapping.test.ts`
pins the whole mapping. Nothing can create a campaign remedy option except the seed,
which writes only `replacement` and `refund`, so no live campaign changes behaviour.

The consumer app's own `RemedyType.DISPOSAL_INSTRUCTION` vocabulary is deliberately left
alone. It is a display classification (a disposal instruction posts nothing, so it asks
for no mailing address), it is unreachable because no remedy option can carry that code,
and the ledger now refuses the code rather than mis-recording it.

**Two rows were already covered, and this matrix had understated them.** D28 and D29 were
listed as unproven against inputs that the guard tests already walk: the table in
`tests/disposal-guards.integration.test.ts` includes `laboratory_report` and
`cbp_seizure_record`, and the test that refuses to open a task uses
`measure: consumer_return`. They are proven above, with the row named.

**The branch that suspends a permission on a new batch cannot be reached, and that is
fine.** `submitEvidenceBatch` suspends every active authorization for the task, so a
permission never outlives the evidence it rested on. But an active authorization implies
a batch was accepted, and the policy refuses a new batch unless the latest one is absent,
sent back, or superseded — so no state exists in which a submission meets a live
permission. The protection is the submission gate itself, which is stricter: accepted
evidence cannot be replaced at all. The suspension is left in place as a second line that
costs nothing, and D09 is proven against the gate that actually fires.

**How the browser rows were established, and what they need.** The consumer runs used a
real disposal task: an approved, authorizing instruction version was installed on the
demo campaign version, a claim was submitted through the real service, and the resume
token was read out of the queued confirmation email. Two local limits shape what a
browser run can reach: the blob adapter is the not-implemented stub, so a real upload
answers 501, and the in-app browser cannot drive a file input. Claims were therefore
submitted with their evidence rows already technically verified — the upload _UI_ is
covered by D06, which was checked separately. D03's skip path needs the five-step claim
walk in the browser; the flow's session deliberately does not persist consumer identity
(`ClaimFlowSessionSnapshot`), so the consumer form has to be filled by hand.

## What the feature still lacks

Four gaps were found by reading for them, and one of them turned out not to exist.
Each is a missing capability, not a broken one — the acceptance matrix above is about
criteria, this is about what a consumer or an operator still cannot do.

**A review outcome never reaches the consumer.** The confirmation email is the only
disposal-related message in the system; there is no path that mails an acceptance, a
resubmission request, a permission, or a closure. Evidence review is asynchronous by
design (D18), so after submitting photos the consumer has to return and press _Refresh
status_ to learn anything. Closing this has a design constraint worth stating: the task
token is stored only as a hash, so **no later message can reconstruct the resume link**
the confirmation email carries — it exists only in memory at submission time. The
choices are to send no link and point at the original email (whose link is valid for 90
days and which already says to keep it), or to rotate a new token, which invalidates the
one already sent because `disposal_tasks.token_hash` holds a single value. The first is
the smaller and safer of the two.

**An exception declaration asks for a follow-up nothing surfaces.** The consumer page
promises _our team follows up_ when a statement is recorded, and D20 shows the statement
is stored faithfully — but no admin surface lists the tasks that ended that way, and the
task is closed, so it leaves every work queue.

**The evidence retention period has no operator surface.** It is a configured default,
and the business value is still one of the open questions below. (Distinct from the
`incident_evidence_retention` hold reason, which is a pause and does have a UI.)

**Locally there is no blob storage.** Composition wires
`NotImplementedPrivateBlobAdapter`, so a real upload answers 501 and photo evidence can
only be exercised by writing verified rows directly. That is why the browser runs above
submitted claims with their evidence already verified.

Closing that is a two-sided change, which is worth knowing before starting it. A server
adapter implementing `PrivateBlobPort` over the local filesystem is the obvious half and
is needed either way, but it is not sufficient: the browser uploads through `put()` from
`@vercel/blob/client` (`claim-flow.ts` and `disposal-evidence.ts`), which performs the
transfer itself. `handleUploadUrl` is configurable, but that is only the route that mints
the token — the destination of the transfer is the SDK's own. Whether that destination can
be redirected is unconfirmed, so the choice is between a development-only client branch
that uploads to a local endpoint, or routing the app's uploads through our own endpoint in
every environment. Deciding that first avoids writing the server half twice.

Creating a new instruction version is **not** on this list: the console can do it
(`createDisposalInstruction`, used from the content library page). A first version of
this note claimed otherwise on the strength of a search for the service method name
rather than the client wrapper — recorded here because a wrong gap is worse than no gap.

## What this means for §7.3

The P0 slice — D01–D08, D12–D16, D25–D29 — is proven at the service layer and, for the
consumer and admin surfaces that exist, in a browser. Within it, D03's skip path still
needs a browser run; everything else closed after this matrix was first written (D13,
D14, D15, and the D09–D11, D16, D17, D19, D21, D24, D28, D29 rows above).

What remains is small and named: D03's skip path needs a five-step claim walk in a
browser (the flow's session deliberately does not persist consumer identity, so the form
must be filled by hand); D23's screen-reader half has no way to be exercised here; D27
depends on a content pack that does not exist; and E2, E3 and E4 are deployment,
rehearsal and business prerequisites rather than code. None of those is a known defect.

## Prerequisites this matrix cannot resolve

Real enablement is blocked on the business side, not here: the approval material that
permits consumer disposal, the content pack (approved steps, example photos, safety
warnings, declaration text), the evidence retention period, and the answer to who may
confirm a product as affected. No campaign has approved instructions, so the feature is
dark by construction rather than by configuration.
