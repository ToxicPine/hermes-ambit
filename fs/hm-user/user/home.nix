{
  config,
  lib,
  pkgs,
  ...
}:

let
  sources = import ../../hm-base/npins;

  unstable = import sources.nixpkgs-unstable {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfree = true;
  };
in
{
  imports = [
    (import ../../hm-base { })
    ./managed.nix
  ];

  home.file = {
    ".agents/skills/ghwc-worktrees".source = ./skills/ghwc-worktrees;
    ".agents/skills/ghwrc-repos".source = ./skills/ghwrc-repos;
    ".agents/skills/foolfad-task-state".source = ./skills/foolfad-task-state;
    ".agents/skills/nestail-service-urls".source = ./skills/nestail-service-urls;

    ".hermes/skills/ghwc-worktrees".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/ghwc-worktrees";
    ".hermes/skills/ghwrc-repos".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/ghwrc-repos";
    ".hermes/skills/foolfad-task-state".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/foolfad-task-state";
    ".hermes/skills/nestail-service-urls".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/nestail-service-urls";
  };

  home.activation.startCodexRemoteControl = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    [ -n "''${DRY_RUN:-}" ] && exit 0

    state_dir="$HOME/.local/state/codex-remote-control"
    pid_file="$state_dir/run.pid"
    log_file="$state_dir/run.log"

    mkdir -p "$state_dir"

    if [ -f "$pid_file" ] && ${pkgs.coreutils}/bin/kill -0 "$(${pkgs.coreutils}/bin/cat "$pid_file")" 2>/dev/null; then
      exit 0
    fi

    cd "$HOME"
    ${pkgs.util-linux}/bin/setsid \
      ${pkgs.coreutils}/bin/nohup \
      ${unstable.codex}/bin/codex remote-control \
      >"$log_file" 2>&1 </dev/null &
    echo $! > "$pid_file"
    disown || true
  '';
}
