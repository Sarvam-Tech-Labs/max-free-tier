# Contributing

Thanks for helping keep free tiers free of surprises.

- **New provider to watch?** Add it to `watch/urls.yaml` (prefer a page's open-source/Markdown source if it has one,
  else the page with a `css: main` + `html2text` filter). Check it isn't noisy: run urlwatch twice; the second run
  must print nothing.
- **A free-tier number changed?** Update `usage/src/limits.ts` (cite the source, bump `LIMITS_AS_OF`) and its test.
- **Changes to `uptime/` or `usage/`** are vendored upstream projects. Bug fixes and features should go to
  [FlareWatch](https://github.com/saminnet/flarewatch) or
  [usage-guard-collector](https://github.com/HowardZlh/usage-guard-collector) first; see docs/UPSTREAM.md.
- Run `pnpm test` (root) and `cd usage && pnpm test` before opening a PR. Never commit a real client registry.
