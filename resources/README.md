# resources/

Static files for the Resources tab (PDFs, and any other downloadable
material), plus `manifest.json` - the list of entries the tab actually
displays. Served alongside `index.html`; not part of the single-file app's
own script, and not processed by anything at build/deploy time.

`index.html` fetches `manifest.json` at runtime, fresh, every time the
Resources modal opens (see `[RESOURCES]` there) - so updating the manifest
and pushing to `main` is enough for students to see the change on their next
open. No index.html edit, no redeploy of the sim's own script.

## Adding a resource

1. Drop the file in here, e.g. `resources/tiva-induction.pdf`.
2. Run `node resources/sweep-resources.js`. It scans this folder for files
   not yet in `manifest.json`, and for each one prompts for a **Name** and a
   **Topic**, then appends the entry itself (type is guessed from the file
   extension). Existing entries are never touched.
3. Review the diff, commit `manifest.json` together with the new file(s)
   here, and push to `main` - GitHub Pages serves both automatically at
   `synapse.hypnos.one/resources/...`.

(Or skip the script and edit `manifest.json` by hand - it's a plain JSON
array of `{title, type, url, description}`, `type` one of `pdf` / `video` /
`link`, `description` optional. The script is just a shortcut for the same
edit.)

## Doing it automatically on commit

One-time setup, per machine you commit from:

```bash
git config core.hooksPath .githooks
```

After that, `git commit` runs the sweeper for you whenever `resources/` has a
file `manifest.json` doesn't know about yet: it prompts for Name/Topic right
there in your terminal and folds the updated `manifest.json` into the commit
you're making. A commit that doesn't touch `resources/`, or where
everything's already synced, passes straight through untouched.

Needs a real terminal to ask its questions - most GUI git clients (VS Code's
Source Control panel, GitHub Desktop) don't give hooks one, so a commit with
something new to sync aborts there with instructions rather than hanging. Run
`node resources/sweep-resources.js` yourself first in that case, then commit
again. Not set up automatically by cloning the repo - git never auto-enables
hooks from a fresh clone, on purpose.

## Videos

Don't put video files in here. GitHub has a hard 100MB per-file limit, and
git isn't built for streaming media - it just bloats the repo. Upload the
video elsewhere (YouTube works fine unlisted, not public) and use that
external URL as `url` instead.

## Portability tradeoff

CLAUDE.md documents `index.html` as a single artefact a teacher can save,
email or open offline. Because the Resources tab now fetches `manifest.json`
at runtime rather than embedding the list, this is a stronger version of that
tradeoff than a plain relative link: `fetch()` of a same-origin file fails
outright under `file://` (a browser security restriction - verified, not a
theoretical concern), so opening `index.html` by double-click shows a
"couldn't load" message in the Resources tab specifically, rather than a
working-but-possibly-broken-link tab. Every other part of the sim - the
physiology model, scenarios, drug cabinet - is completely unaffected and
stays fully offline-capable. Accepted as of v4.40/v4.41 so the tab can update
live without redeploying `index.html` for every resource change.
