# resources/

Static files for the Resources tab (PDFs, and any other downloadable
material). Plain files served alongside `index.html` - not part of the
single-file app itself, and not processed by anything.

## Adding a resource

1. Drop the file in here, e.g. `resources/tiva-induction.pdf`.
2. Run `node resources/sweep-resources.js`. It scans this folder for files
   not yet in the `RESOURCES` array in `index.html`, and for each one prompts
   for a **Name** and a **Topic**, then appends the entry itself (type is
   guessed from the file extension). Existing entries are never touched.
3. Review the diff, commit `index.html` together with the new file(s) here,
   and push to `main` - GitHub Pages serves it automatically at
   `synapse.hypnos.one/resources/tiva-induction.pdf`.

(Or skip the script and edit the `RESOURCES` array in `index.html` by hand -
grep for `[RESOURCES]`. The script is just a shortcut for the same edit.)

## Videos

Don't put video files in here. GitHub has a hard 100MB per-file limit, and
git isn't built for streaming media - it just bloats the repo. Upload the
video elsewhere (YouTube works fine unlisted, not public) and use that
external URL as `url` instead.

## Portability tradeoff

CLAUDE.md documents `index.html` as a single artefact a teacher can save,
email or open offline. A `resources/`-relative link only resolves when
`index.html` is loaded from the deployed site, or from a folder that still
has this `resources/` directory sitting next to it - not from a standalone
copy of just `index.html`. Accepted as of v4.40 so real PDFs can be linked
without depending on external hosting for everything.
