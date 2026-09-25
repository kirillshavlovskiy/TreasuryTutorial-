---
name: fx-log-knowledge
description: Append an entry to docs/knowledge-log.md for the commit that was just made — what was measured, what was tried and rejected, what gap was left open, what existing claim turned out to be false. Use immediately after every commit, and when asked to "log this", "write the knowledge entry", "record what we learned", or "note this down". Writes only to docs/knowledge-log.md; it never touches the knowledge layer under .claude/rules/project/.
user-invocable: true
allowed-tools: Bash(git *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Bash(rg *), Read, Edit, Grep, Glob
---

# FX Log Knowledge

Write down the part of the work that the diff does not carry.

Run this **after every commit**. It takes about a minute, and most entries are three lines.

---

## Why this exists, and the trap it is built to avoid

The expensive part of a change is rarely the code. It is the approach that was tried for an hour
and abandoned, the number someone actually measured instead of assuming, and the documented claim
that turned out to be wrong. That knowledge lives in a session transcript and dies with it.

The trap is the opposite failure: a log that restates the commit message. This repository's commit
bodies already run to a median of 12 lines, so a paraphrase adds nothing and costs attention. A log
nobody reads protects nothing.

**So the test for every line you write is: would this have been lost otherwise?** If it is in the
diff or the commit message, leave it out.

## Step 1 — Read the format

`docs/knowledge-log.md` carries the format, the four labels, and the worked example. **Read it
before writing.** It is the single definition on purpose — a format that exists in two places
drifts, and the copy that falls behind is the one people follow.

Do not restate the format in this skill, and do not invent labels that are not in that file.

## Step 2 — Work out what the commit actually taught

Look at what just happened, not only at the diff:

```bash
git log -1 --format='%h %s%n%b'
git show --stat HEAD
```

Then ask, in this order:

1. **Did you run something to find out?** A version, a date, an exit code, a count, a timing, a
   probe against a real service. That is a **Measured** line. Include the command and its result —
   a conclusion without its evidence rots silently, which is exactly what this log is fighting.
2. **Did you try something that did not work?** An approach abandoned, a library rejected, a
   simpler design that turned out to be wrong. That is a **Rejected** line, and it is the most
   valuable one here — nothing else in the repository records it.
3. **Did you knowingly leave something undone?** A gap accepted with a reason. **Left open.**
4. **Did you find an existing claim to be false?** A comment, a doc, a checklist, a variable name
   that lies. **Corrected** — and name the file, so the next reader can check whether it was
   actually fixed.

If none of the four applies, that is a normal and frequent outcome. Write the heading and
`No finding beyond the commit message.` on one line. Do not pad it.

## Step 3 — Check what you are about to write

- [ ] No restricted data. No real balance, account identifier, counterparty, position-linked rate,
      token or connection string. `check-financial.md` section 6 applies here exactly as it applies
      to a log line, and this file is committed and searchable forever.
- [ ] No prescription. If a line tells future readers what they **must** do, it is an architecture
      decision, not evidence — it belongs in `.claude/rules/project/decisions.md` via
      `fx-record-decision`, which asks for confirmation first. Evidence describes the past; a
      decision constrains the future. Keep them apart.
- [ ] No paraphrase of the commit message.
- [ ] Every claim is either something you ran, or is marked as the assumption it is.

## Step 4 — Append it

Newest first, directly below the marker comment at the bottom of the header in
`docs/knowledge-log.md`. Use the real short SHA and the real commit subject:

```bash
git log -1 --format='%h %s'
```

Do not rewrite or tidy older entries. They are a record, not a document — an entry that was true
when written stays as it was, and a later correction is a new entry that says so.

## What this skill never does

- Write to `.claude/rules/project/` — that layer is confirmation-gated by
  `.claude/rules/project/engineering.md`, and this skill is deliberately outside it so that
  logging after every commit never becomes a speculative edit to the knowledge layer.
- Record an architecture decision. That is `fx-record-decision`.
- Amend, squash or re-commit anything. It appends to one file; committing that file is the next
  commit's business, or it rides along with the change it describes.
- Put anything in the log that the commit message already says.
