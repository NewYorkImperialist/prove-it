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
npm test         # node:test
npm run build    # the client bundle has to compile too
npm run test:browser   # Playwright — builds first, then drives a real browser
```

CI (`.github/workflows/test.yml`) runs exactly these, and `main` deploys to Fly only after they
pass — so a push that fails them blocks the deploy. See the README's Deploying section.

`npm test` has no DOM. That is how a whole screen once shipped having never been rendered: its
data layer was fully unit-tested and every visual and navigation defect in it survived to
production. Anything with layout or interaction in it needs a `test-browser/` spec too — the
landscape-phone viewport (844×390) is the one that catches things, because it is wide enough to
match `desk:` while being only ~390px tall.
