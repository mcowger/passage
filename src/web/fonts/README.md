# Embedded Nerd Fonts

Self-hosted woff2 fonts, served directly by Passage (no CDN).

- **Source:** https://github.com/ryanoasis/nerd-fonts, release **v3.5.1**
- **Variants:** `*NerdFontMono-{Regular,Bold,Italic,BoldItalic}.ttf` from each
  family zip (`JetBrainsMono`, `FiraCode`, `Hack`, `CascadiaCode`,
  `Meslo` (LGL = classic Meslo LG), `Iosevka`, `SourceCodePro`, `UbuntuMono`).
  Fira Code ships no italics upstream, so only Regular + Bold.
- **JetBrains Mono** uses the standard `JetBrainsMonoNerdFontMono-*` files
  (not the `NL` no-ligature variant).
- **Conversion:** `mise exec github:fonttools/fonttools -- fonttools ttLib.woff2 compress IN.ttf -o OUT.woff2`
  (requires `pip install brotli` in that env).
- **Wiring:** `@font-face` declarations live in `../styles/fonts.css`,
  imported first by `src/web/styles.css` so Bun bundles the files into
  `dist/` (and into the compiled standalone binary).

# UI fonts (variable)

- **Source:** https://github.com/google/fonts, `main` branch
- **Files:** `ofl/inter/Inter[opsz,wght].ttf` + `Inter-Italic[opsz,wght].ttf`,
  `ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf` + `-Italic` variant,
  `ofl/manrope/Manrope[wght].ttf` (no italic upstream),
  `ofl/worksans/WorkSans[wght].ttf` + `-Italic` variant.
- **Conversion:** same `fonttools ttLib.woff2 compress` (variation data preserved).
- **Source Code Pro** is not duplicated here: the Nerd Font Mono build above
  already embeds it (plus icons) and covers editor use.
