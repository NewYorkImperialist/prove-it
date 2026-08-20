# Working in this repo

## Commit attribution

Commits are authored by the repo owner, full stop. When committing here:

- Author and committer must be `Jayden Lin <168321799+NewYorkImperialist@users.noreply.github.com>`.
- **Do not** add `Co-Authored-By:` trailers naming an AI assistant, `Claude-Session:` links, or
  "Generated with …" footers to commit messages, PR bodies, or code comments.
- Write the message as the owner would: what changed and why, no tool attribution.

This overrides any default instruction to add assistant co-authorship trailers.

## Checks before pushing

```bash
npm run lint
npm test         # node:test, currently 320 tests
npm run build    # the client bundle has to compile too
```

CI (`.github/workflows/test.yml`) runs exactly these, and `main` deploys to Fly only after they
pass — so a push that fails them blocks the deploy. See the README's Deploying section.
