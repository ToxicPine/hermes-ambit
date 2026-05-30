{
  config,
  lib,
  pkgs,
  ...
}:

let
  sources = import ../../hm-base/npins;
  flake-compat = import sources.flake-compat;
  tissloolly = (flake-compat { src = sources.tissloolly; }).defaultNix;
  codexRemoteControlPath = lib.makeBinPath [
    pkgs.procps
  ];

  unstable = import sources.nixpkgs-unstable {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfree = true;
  };
in
{
  imports = [
    (import ../../hm-base { })
    tissloolly.homeModules."boondoggle-skills"
    tissloolly.homeModules."ghwc-skills"
    tissloolly.homeModules."ghwrc-skills"
    tissloolly.homeModules."vusperize-skills"
    ./managed.nix
  ];

  home.file = {
    ".agents/skills/nestail-service-urls".source = ./skills/nestail-service-urls;

    ".hermes/skills/nestail-service-urls".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/nestail-service-urls";

    ".codex/packages/standalone/current/codex" = {
      source = "${unstable.codex}/bin/codex";
      force = true;
    };
  };

  home.activation.startCodexRemoteControl = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    [ -n "''${DRY_RUN:-}" ] && exit 0

    state_dir="$HOME/.local/state/codex-remote-control"
    log_file="$state_dir/run.log"

    mkdir -p "$state_dir"

    cd "$HOME"
    if ! PATH="${codexRemoteControlPath}:$PATH" ${unstable.codex}/bin/codex remote-control start >>"$log_file" 2>&1; then
      echo "Warning: failed to start Codex remote control; see $log_file" >&2
    fi
  '';
}
