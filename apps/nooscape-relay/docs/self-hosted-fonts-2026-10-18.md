# Self-hosted fonts (2026-10-18)

The site used two typefaces, Space Grotesk and DM Mono, loaded from Google Fonts (`fonts.googleapis.com` for the stylesheet and `fonts.gstatic.com` for the files). For a site whose pitch is evidence and privacy, that was a third-party request on every first visit, and the privacy page said so ("Google receives your address and browser details when a page loads"). It was item L6 of the [consulting review](./consulting-review-2026-10-16.md) and was held for the operator's go, because it changes the privacy page and the content security policy in the same commit. The operator agreed on 2026-10-18.

## What changed

- The two typefaces come from the npm packages `@fontsource/space-grotesk` and `@fontsource/dm-mono` (5.3.0, both under the SIL Open Font License, which allows serving them; a test reads the license file). `client/src/main.tsx` imports Space Grotesk at 400, 500, 600 and 700 and DM Mono at 400 and 500, the weights the Google link asked for. The bundler emits the `@font-face` rules into the site's own stylesheet and the font files into `/assets`, which the server already serves with a one year immutable cache.
- `client/index.html` no longer has the two `preconnect` links or the Google stylesheet link.
- The content security policy is derived from the built `index.html`, so it follows: `font-src 'self'` and `style-src 'self' 'unsafe-inline'`, with no Google host. The fallback policy (served only if the built page cannot be read) no longer names Google either. `server/fontsSelfHosted.test.ts` holds the page, the derived policy and the fallback to that.
- The privacy page now says the two typefaces are served from nooscape.si itself, so loading them sends nothing to a third party, and its "last changed" date is 18 October 2026. `client/src/pages/legalPages.test.ts` now expects the one remaining third party in `index.html` to be Umami Cloud, and fails if a font host comes back.

## What it looks like and costs

- The faces are the same files Google served, so the page is unchanged: the hero measures the same at eight widths from 1920 to 360 pixels (the same right edge for the figures and the same bottom for the stats at each).
- Each package's stylesheet declares its subsets with a `unicode-range` (latin, latin-ext and vietnamese), so a page downloads only the subsets its text needs. On the home page, the privacy page and the checker page, six, five and five woff2 files were fetched, all `latin`, 12 to 15 KB each. Nothing is inlined as a `data:` URI, which the policy would block.
- The build carries 16 `@font-face` rules and 32 files in `dist/public/assets` (16 woff2 and 16 woff, 354 KB on disk). The woff files are the old fallback format from the packages and no current browser asks for them; they take disk space and nothing else.
- `font-display: swap` is as before: text shows in the fallback face until the file arrives. There is no preload, because the file names carry a hash that the bundler chooses. One origin fewer to connect to (Google's two) is what makes the first paint faster.

## Checked

On a built server with its real policy, in headless Chrome: both families loaded at every weight a page used, the heading is set in Space Grotesk, the policy names no font host, the console is empty (a policy violation would log there), and the only request that leaves the site is the Umami script, which the privacy page names.

## Later

Dependabot will track the two packages in the minor and patch group. Dropping the unused woff files would need a bundler setting or a hand-written `@font-face`; it is not worth the maintenance.
