# AGENTS.md

Project instructions for AI agents working in this repository.

## Confirmation required before acting

**Ask the user for explicit approval before running any shell command or
modifying any file.** Do not bundle actions together; approval for one command
is not approval for the next.

### Shell commands

Ask first, then wait for a reply, before running any `shell`/`bash` command that
does any of the following:

- writes, moves, or deletes anything (`>`, `>>`, `rm`, `mv`, `cp`, `touch`,
  `mkdir`, `tee`, `sed -i`, output redirection of any kind)
- installs, removes, or changes dependencies (`pnpm add/remove/update/install`,
  `npm i`, `npx`, `brew`, git commands that alter state)
- runs project scripts, builds, tests, typechecks, linters, or dev servers
  (`pnpm build`, `turbo`, `next dev`, `jest`, `vitest`, `tsc`, `eslint`, ...)
- starts any background process, server, or long-running command
- touches git state (`commit`, `push`, `checkout`, `merge`, `rebase`, `reset`,
  `stash`, `clean`)
- reaches the network or the filesystem outside this repository

Commands that are safe to run without asking, because they only read and change
nothing:

- `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `tree`, `file`, `stat`
- `git status`, `git log`, `git diff`, `git show`, `git branch` (read-only)

For anything else: state the exact command, say what it will change, and wait.
If a read-only command is needed only to answer a question you could not resolve
otherwise, run it and mention it in your reply.

### Editing code

Before the `edit`, `write`, or `patch` tool touches a file:

1. Say which file(s) you intend to change and why.
2. Show the substantive change -- the diff, or the new function/signature -- not
   just a file name.
3. Wait for explicit approval.

This applies to first-time edits and to follow-up edits in the same session. It
also applies to edits you consider obviously safe: one-line typo fixes, import
reordering, formatting, and renaming are still changes. Batch related edits into
a single described proposal rather than asking once per line.

Never commit, push, or amend unless the user asks for that specific action in
that specific message.

## Project setup

Use `pnpm` (there is a `pnpm-workspace.yaml` and a committed `pnpm-lock.yaml`;
the lockfile must not be rewritten casually). The repo is a Turborepo monorepo:

- `apps/api` -- API service
- `apps/web` -- Next.js frontend
- `packages/protocol` -- shared types
- `pi/agent` -- native agent (CMake)

Do not edit generated output directly. `dist/`, `.next/`, and `node_modules/`
are build artifacts. `node_modules`, `.pnpm-store`, `.next`, `dist`, `.env`,
`.env.local`, and `*.tsbuildinfo` are gitignored. Change the source and let the
build regenerate the rest.

## Secrets

`.env.example` is committed and safe to read. The real `.env` and `.env.local`
are not: never read, print, log, echo, or commit them, and never paste their
contents into a reply. If a task appears to need a value from `.env`, ask the
user for it instead.

## Communication

Report what actually happened. If a command failed, say so and include the
error. If you did not verify something, say that rather than implying you did.
Do not describe a change as complete until the relevant build or test has
actually been run and passed.
