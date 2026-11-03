# Archived club crests

The six PNGs in this directory are byte-for-byte copies of the icons before the
first approved crest replacement (base commit `7ce7062`). They are not referenced
by the app or SW. They have not been modified during the final crest replacement.

The next approved image remains unchanged at `../club-crest-original.png`.
Its six derived icons (from main `f5429c4`) are archived in `crest-v4/`.

The current owner-supplied original is `../club-crest-final-original.png`.
Regenerate the current icons with `node scripts/generate-club-crest.cjs`, using
the Playwright setup from `tests/browser.cjs` and its optional local renderer
variables. The complete 3:4 image is fitted onto opaque `#001329` square canvases:
94% height for regular icons, favicon and Apple Touch Icon, and 63% height for
maskable, keeping even the image corners within the 40%-radius safe circle.
No artwork is cropped, redrawn, recoloured or rearranged.

To restore an archived crest, copy the chosen icons to the repository root,
update all artwork references and URL versions, and bump the SW cache again.
See `../../docs/pwa-launch.md` for the current launch and update behaviour.
