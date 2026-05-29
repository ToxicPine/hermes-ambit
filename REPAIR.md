## 2026-05-27

- `/nix` is seeded at boot from image `/nix-base` via `cp -aln`; Fly only mounts `/data`, so `/nix` still pressures rootfs during seed/rebuild.
- Current HM generation measured ~3.1 GiB on disk. Large roots included `codex` (~311 MiB), full `glibc-locales` (~222 MiB), Deno (~143 MiB), Nix direnv (~157 MiB), and Hermes `all` extras.
- Added `fs/hermes/package.nix` to reuse upstream Hermes packaging but intercept `python.nix`: replace upstream `all` extra with an exact dependency group list such as `cli`, `pty`, `mcp`, `acp`, `web`, and `messaging`.
- Slimmed default HM user profile for gateway use: removed `codex`, Deno, Node/Bun/flyctl/gh, direnv-instant/nix-direnv, and switched HM locales to `glibcLocalesUtf8`.
- New HM generation measured ~1.4 GiB on disk. Re-enabled prebuilt HM profiles so `/nix-base` seeds the already-built activation and Fly does not rebuild NPM `node_modules` trees on rootfs during boot.
- Deployed image `sha256:61958b6d...`; first new boot seeded HM and rebuilt successfully. Remaining warning was old `/data/nix-cache` permissions, fixed by making the cache tree writable at entrypoint start.
- Deployed follow-up image `sha256:271a133b46c51cb63196ee707773e33c16a7034959c7b44a245c73169655246a` (`img_g72wp0dnxog5vyxk`). Verified machine `0805623be51e08` started at `2026-05-27T13:18:59Z`, rebuild exited, and Hermes gateway started at `2026-05-27T13:27:06Z`.
- Post-boot Fly disk check: rootfs `1.2G/7.8G` used with `6.2G` free; `/data` `1.1G/9.8G` used with `8.2G` free. `/data/nix-cache` and `/data/nix-cache/nar` are writable.
