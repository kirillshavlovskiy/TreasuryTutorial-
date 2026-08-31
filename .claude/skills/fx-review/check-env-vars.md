# Environment variables checklist

Three places describe this application's configuration, and **all three must agree**:

1. the code that reads `process.env.*`
2. `.env.example`
3. the Environment Variables table in `README.md`

Keeping them in sync is a decision, not a preference. A variable documented in one place and
missing from another is how a deploy fails at 2am with nobody knowing which value was needed.

---

## 1. When this checklist applies

Any change that adds, renames, removes, or changes the requiredness of an environment variable.
This includes a variable a **library** reads on its own from `process.env` without an explicit
reference in this codebase — NextAuth's `AUTH_SECRET`, the AWS SDK's credential chain, and similar.

## 2. The rule

- [ ] The variable is in `.env.example`, with its generation command or default if it has one.
- [ ] The variable is in the README Environment Variables table, **in the same change**. Not
      deferred to a follow-up.
- [ ] The Required column says explicitly whether the application **runs without it and degrades a
      named feature**, or **fails outright**. Match the convention the table already uses.
- [ ] No second table or list of environment variables was created anywhere else. If a document
      needs to mention configuration, it links to the existing table.

Source: `CLAUDE.md` → Environment Variables — keep in sync.

## 3. How to audit

Run the drift check:

```bash
node .claude/skills/fx-review/scripts/env-drift.mjs
```

It reports seven sections: variables missing from each of the two documents, variables in one
document but not the other, entries the code never references, entries documented as optional,
and runtime-provided names.

The underlying grep, if you want to run it by hand:

```bash
git grep --untracked -ohE "process\.env\.[A-Za-z_][A-Za-z0-9_]*" -- app lib components auth.ts next.config.ts ':(exclude)**/*.test.ts' ':(exclude)**/*.test.tsx' | sed 's/process\.env\.//' | sort -u
```

Restrict it to `app/`, `lib/`, `components/`, `auth.ts` and the config files. Exclude
`node_modules`, `.next`, `.claude/worktrees` and `*.test.ts`.

**The grep is necessary but not sufficient.** It cannot see a variable a library reads on its own.
Before concluding the list is complete, read the existing entries in `.env.example` for those cases.

## 4. Runtime-provided variables

Some variables are set by the platform and never by a person: `NODE_ENV`, `VERCEL_ENV` and
`NODE_PATH`.

The `AWS_*` family is **not** in this group. `AWS_REGION` and `AWS_EC2_METADATA_DISABLED` are real,
overridable configuration and belong in the S3 section of the README alongside `S3_*`;
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` are read by the AWS SDK rather
than by this codebase, but a person still sets them locally. Do not flag the README's current
layout of these as a violation — it is deliberate.

- [ ] These are listed in a clearly separated subsection — "set by the runtime, not by you" — rather
      than omitted.

Omitting them makes the list look complete when it is not, and someone eventually adds one by hand
and breaks a deployment. Listing them without a marker makes people try to set them.

## 5. Pre-existing drift versus drift this change introduced

The three sources were brought into sync when this checklist was written, and the drift check
reports `IN SYNC`. If it ever reports drift again, split the finding into two lists before
reporting:

- variables **this change** touched → must be fixed now, blocks the push
- variables that were **already** adrift → report once as a note, and do not block an unrelated
  change on cleaning them

A gate that blocks every change on pre-existing debt gets switched off, and then it protects
nothing.

## 6. When the check cannot run

`RESULT: SCAN FAILED` is not `IN SYNC`. It means no `process.env` reference was found at all,
which cannot be true for this application — git is missing, this is not a repository, or a
pathspec stopped matching. Fix the scan before trusting any verdict; the script exits `1` so the
gate cannot pass on it.
