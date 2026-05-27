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

  wghc = pkgs.callPackage ./wghc { };
in
{
  imports = [
    (import ../../hm-base { })
    ./managed.nix
  ];

  home.packages = [
    wghc
  ];

  home.file = {
    ".agents/skills/wghc-cloning/SKILL.md".source = ./skills/wghc-cloning/SKILL.md;
    ".agents/skills/terry-task-state/SKILL.md".source = ./skills/terry-task-state/SKILL.md;

    ".hermes/skills/wghc-cloning".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/wghc-cloning";
    ".hermes/skills/terry-task-state".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.agents/skills/terry-task-state";
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
