These six PNG files are byte-for-byte copies of the club icons before the approved
crest replacement (base commit 7ce7062). They are not referenced by the app or SW.

The original replacement image is `../club-crest-original.png`, copied without
modification from the image attached by the club owner. Regenerate the current
icons with `node scripts/generate-club-crest.cjs` using the Playwright setup from
`tests/browser.cjs` (including its optional local browser environment variables).

The generator fits the complete 2:3 image into opaque square canvases, preserving
its aspect ratio. The maskable image is 64% of the canvas height, keeping even its
corners inside the central 40%-radius safe circle. No artwork is cropped, redrawn,
recoloured or rearranged.

To restore the previous crest, copy these PNGs to the repository root, update
the image URL versions and bump the SW cache version again before publishing.
