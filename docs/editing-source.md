# Editing source in this repository

Written because the same mistake was paid for four times in one week, and once it
corrupted a source file badly enough to need `git checkout` to recover.

## Never patch source from an inline shell command

`node -e "..."` inside a shell hands your code to two extra parsers. Backticks become
command substitution, `!` triggers history expansion, and `${...}` is interpolated
before Node sees it. The result is a patch that is silently wrong rather than an error:
template literals written as `\n`, or a whole insertion landing somewhere else.

Use one of:

- the editor's own write for a whole file or a whole function;
- a **separate script file** (`Write`, then run it), for a targeted change.

## Never locate an edit by line number

Line numbers drift with every format pass. An edit addressed by position lands in the
wrong place and reports success — it once overwrote the `draftId` argument of a call
several hundred lines away from the intended target.

Locate by content: a unique anchor string, or an index found by searching for one.

## Assert the inserted statement, not a substring of it

This is the one that keeps recurring. A check like

```js
if (!file.includes('latestBatch')) throw new Error('insertion failed');
```

passes against a file that already contains `latestBatchReviewStatus`, so an insertion
that never happened reports success. The same shape of check failed on a type name that
another line already referenced, on a two-character marker that appeared in unrelated
prose, and on an indentation that differed by two spaces.

Assert the exact thing you meant to write:

```js
if (!file.includes('const latestBatch = await service.getLatestBatchForAdmin')) {
  throw new Error('insertion did not happen');
}
```

## Then confirm it independently

An insertion check proves the text is present; it does not prove the code runs. For a
change that matters, run the thing: the typecheck, the test, or the command. A patch
script that reports success is not evidence.

## Cleaning up test fixtures

Delete each row in its own statement, tolerating failure, and report what failed.
A single delete chain aborts at the first foreign-key violation and leaves the database
half-cleaned while looking like it finished. Order matters: `reportability_reviews`
before `incidents`, `document_uploads` before `claim_drafts` (the draft reference is
`ON DELETE SET NULL`, and nulling the owner violates the owner check).

## Do not chain a patch script's cleanup with `&&`

A patch script that fails halfway leaves its own file behind, and `python patch.py && rm
patch.py` does not remove it — the `&&` short-circuits on the failure, so the delete never
runs. A later `git add -A` then sweeps the script into a commit, and removing it takes an
`--amend`. Run the script, then delete it as its own command, and read `git status` before
committing: a one-off script has no business in the history.

The same `&&` reflex hid a second thing in the same session: a script that printed
"converted" and then threw, leaving the first file converted and the second untouched, so
the working tree was half-patched while the output looked like success. Fail loudly at the
top of the script (assert every anchor before writing anything) rather than at the end.

## Python heredocs mangle backslashes exactly like `node -e`

`<<'PY'` looks quoted enough to be safe, and is not: `'\'` arrives as `'\'` and the script
dies with `SyntaxError: EOL while scanning string literal`. Twice in one session. The fix
is the one above — write the script to a file with the editor, then run the file.

One more instance for "Never locate an edit by line number": a replacement addressed as
"lines 304-314" removed a state declaration that shared that range with the lines being
rewritten, and the component then failed to compile on a name that no longer existed. The
type checker caught it, which is the only reason it was cheap.
