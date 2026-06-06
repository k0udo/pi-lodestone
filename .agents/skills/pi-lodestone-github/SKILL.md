---
name: pi-lodestone-github
description: "Project-specific GitHub workflow for k0udo/pi-lodestone: use gh/git to inspect and manage issues, PRs, releases, npm publishing prep, and Pi package-gallery/package-repo readiness."
---

# pi-lodestone GitHub

Use this skill when working on GitHub tasks for `k0udo/pi-lodestone`: issues, PRs, releases, tags, Actions, npm release coordination, or Pi package-gallery/package-repo readiness.

## Repository facts

- GitHub repo: `k0udo/pi-lodestone`
- npm package: `pi-lodestone`
- Default branch: `main`
- Remote: `git@github.com:k0udo/pi-lodestone.git`
- Purpose: persistent memory for the Pi coding agent, tuned for local LLMs.
- Package goal: installable via `pi install npm:pi-lodestone`, eventually discoverable/included in Pi's package ecosystem.

## Safety rules

- Start read-only: inspect git status, remotes, repo metadata, issues/PRs/releases before acting.
- Mutations require explicit user request: issue/PR/release/tag/comment creation or edits, pushes, workflow dispatches, npm publishing, or repository setting changes.
- Never print GitHub/npm tokens or secrets. Avoid `gh auth token` unless the user explicitly asks for credential diagnostics.
- Never force-push, delete branches/tags, publish npm, or create releases without direct confirmation for that exact action.
- Before committing: inspect files, run relevant checks, stage explicit paths only, verify staged changes.

## Discovery commands

```bash
git remote get-url origin
gh repo view k0udo/pi-lodestone --json nameWithOwner,url,isPrivate,description,defaultBranchRef,pushedAt,latestRelease
gh issue list --repo k0udo/pi-lodestone --limit 20 --json number,title,state,labels,updatedAt,url
gh pr list --repo k0udo/pi-lodestone --limit 20 --json number,title,state,headRefName,baseRefName,isDraft,updatedAt,url
gh release list --repo k0udo/pi-lodestone --limit 20
gh run list --repo k0udo/pi-lodestone --limit 20 --json databaseId,status,conclusion,workflowName,headBranch,createdAt,url
```

## Development workflow

1. Search project memory when relevant: `memory-search(query, projectOnly=true)`.
2. Check repo state with `gitea status`; inspect path-limited diffs before edits.
3. Implement changes.
4. Run `npm test`.
5. For package readiness, run `npm pack --dry-run`.
6. Keep `README.md` and `skills/lodestone/README.md` aligned with user-facing behavior.
7. If committing, use explicit `gitea add` paths, `gitea check`, then `gitea commit`.

## Package readiness checklist

`package.json` should preserve:

- `keywords` includes `pi-package`
- `repository`, `homepage`, and `bugs` point to `https://github.com/k0udo/pi-lodestone`
- `pi.extensions` includes `./extension/index.ts`
- `pi.skills` includes `./skills/lodestone`
- `files` includes `extension`, `skills`, `README.md`, and `LICENSE`
- runtime dependencies needed by the extension are in `dependencies`; Pi core packages remain in `peerDependencies` as appropriate for current Pi docs.

Use local Pi docs before making detailed claims about packaging requirements:

- Packages: `/Users/koudo/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.78.1/eff940528d0eae9982e6055e39fc66caaaa2c4d99cc4491b44d70b7ae6d97bdb/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- Skills: `/Users/koudo/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.78.1/eff940528d0eae9982e6055e39fc66caaaa2c4d99cc4491b44d70b7ae6d97bdb/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`

## GitHub issue and PR workflow

- Triage by listing issues/PRs, then fetch only selected details with `gh issue view` or `gh pr view`.
- Create issues only when requested: `gh issue create --repo k0udo/pi-lodestone --title ... --body ...`.
- Create PRs only when requested after a branch is pushed:
  `gh pr create --repo k0udo/pi-lodestone --base main --head <branch> --title ... --body ...`.
- PR bodies should include summary, test results, and package-readiness checks when relevant.

## Release and npm workflow

Use only after the user explicitly asks to release or publish.

1. Verify clean working tree.
2. Review `package.json` metadata and version.
3. Run `npm test` and `npm pack --dry-run`.
4. Bump version if requested; commit and tag `vX.Y.Z`.
5. Publish with `npm publish` only after explicit confirmation.
6. Create a GitHub release with `gh release create vX.Y.Z --repo k0udo/pi-lodestone --title vX.Y.Z --notes ...` only after explicit confirmation.
