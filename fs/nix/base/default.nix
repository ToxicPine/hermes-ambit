{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:

{
  home.stateVersion = "25.11";

  imports = [
    inputs.direnv-instant.homeModules.direnv-instant
    (import ../../hermes { inherit (inputs) hermes-agent; }).hmModule
  ];

  programs.home-manager.enable = true;

  home.sessionPath = [
    "$HOME/.nix-profile/bin"
    "$HOME/.local/state/nix/profiles/home-manager/home-path/bin"
  ];

  programs.bash = {
    enable = true;
    initExtra = ''[[ "$PWD" == "/" ]] && cd'';
    shellAliases = {
      ll = "ls -la";
      rebuild = "cd ~/.nixcfg && home-manager switch --flake .";
    };
  };

  home.packages = (
    with pkgs;
    [
      bun
      curl
      gh
      git
      htop
      nodejs
      openssh
      flyctl
      deno
      tmux
      vim
    ]
  );

  # direnv-instant replaces direnv's normal shell hook, but still relies on
  # direnv itself. Keep nix-direnv enabled alongside it for cached flake envs.
  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

  xdg.configFile."direnv/direnv.toml".text = ''
    [whitelist]
    prefix = [ "${config.home.homeDirectory}" ]
  '';

  home.activation.cacheHomeManagerGeneration = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    cache="file:///data/nix-cache?compression=zstd&parallel-compression=true"

    if [ -n "''${DRY_RUN:-}" ]; then
      echo "Would export Home Manager generation closure to local Nix cache: $newGenPath"
    else
      if mkdir -p /data/nix-cache; then
        touch /data/nix-cache/.copy-lock 2>/dev/null || true
        chmod 0666 /data/nix-cache/.copy-lock 2>/dev/null || true
        ${pkgs.util-linux}/bin/flock /data/nix-cache/.copy-lock \
          ${pkgs.nix}/bin/nix copy --to "$cache" "$newGenPath" \
          || echo "Warning: failed to export Home Manager generation to local Nix cache" >&2
      else
        echo "Warning: failed to create local Nix cache directory" >&2
      fi
    fi
  '';

  programs.tmux = {
    enable = true;
    terminal = "screen-256color";
  };

  programs.direnv-instant.enable = true;
}
