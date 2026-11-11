# Local interface fonts

IBM Plex Sans is the application interface family. These are **unmodified complete
WOFF2** files from IBM's official [`@ibm/plex-sans` 1.1.0 package](https://www.npmjs.com/package/@ibm/plex-sans/v/1.1.0),
downloaded from [the versioned npm archive](https://registry.npmjs.org/@ibm/plex-sans/-/plex-sans-1.1.0.tgz)
on 11 November 2026. Upstream: [IBM/plex](https://github.com/IBM/plex),
[IBM's Cyrillic typeface documentation](https://www.ibm.com/design/language/typography/typeface/).
The font's internal version is 3.005. The package's `LICENSE.txt` is retained
verbatim as [ibm-plex-sans/OFL.txt](ibm-plex-sans/OFL.txt), SIL Open Font License 1.1.

| File | Weight | Bytes |
| --- | ---: | ---: |
| IBMPlexSans-Regular.woff2 | 400 | 63,020 |
| IBMPlexSans-SemiBold.woff2 | 600 | 67,060 |
| IBMPlexSans-Bold.woff2 | 700 | 63,012 |
| Total WOFF2 | | **193,092** |

No italics, light weights, variable font axes or runtime font CDN are included.
Every file contains 895 Unicode mappings, including all 66 Russian letters
(Ё and ё included), extended Cyrillic, Latin and Greek. SHA-256 and coverage
measurements are in [fonts.json](../../docs/typography-refresh/fonts.json).
The OS font stack is the fallback; `font-display: swap` keeps text available.
All weights are precached by service worker v15, including weights not yet used
on the visited screen. The CSS is embedded into the offline HTML; the canonical
source is `typography.css`.

Roboto Condensed is **only a local comparison asset** under
`docs/typography-refresh/trial/`, which the Pages packager excludes. It comes
unmodified from [`@fontsource/roboto-condensed` 5.3.0](https://registry.npmjs.org/@fontsource/roboto-condensed/-/roboto-condensed-5.3.0.tgz),
file `files/roboto-condensed-latin-700-normal.woff2` (700, digits and Latin).
Its original OFL license is beside the trial file. Upstream font:
[google/fonts/ofl/robotocondensed](https://github.com/google/fonts/tree/main/ofl/robotocondensed).
It is never referenced by production HTML/CSS/SW or downloaded by the app.
