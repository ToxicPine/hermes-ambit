{
  sources ? import ./npins,
}:
{
  lib,
  pkgs,
  ...
}:

let
  system = pkgs.stdenv.hostPlatform.system;
  nixpkgs-unstable = import sources.nixpkgs-unstable {
    inherit system;
    config = (pkgs.config or { }) // {
      allowUnfree = true;
    };
  };
  hermes = import ../hermes {
    pkgs = nixpkgs-unstable;
    inherit sources;
  };
  flake-compat = import sources.flake-compat;
  nestailFlake = (flake-compat { src = sources.nestail; }).defaultNix;
  nestail = nestailFlake.packages.${system}.default;
  tissloollyFlake = (flake-compat { src = sources.tissloolly; }).defaultNix;
  tissloolly = tissloollyFlake.packages.${system};
in

{
  imports = [
    hermes.hmModule
  ];

  i18n.glibcLocales = pkgs.glibcLocalesUtf8;

  home = {
    stateVersion = "25.11";

    sessionPath = [
      "$HOME/.nix-profile/bin"
      "$HOME/.local/state/nix/profiles/home-manager/home-path/bin"
    ];

    sessionVariables = {
      NIX_REMOTE = "daemon";
    };

    packages = with pkgs; [
      nixpkgs-unstable.codex
      nestail
      tissloolly.boondoggle
      tissloolly.ghwc
      tissloolly.ghwrc
      tissloolly.vusperize
      openssh
      curl
      git
      gh
      procps
      tmux
    ];

    activation.cacheHomeManagerGeneration = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
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
  };

  programs = {
    home-manager.enable = true;

    hermes-agent = {
      enable = true;

      packageOverrides = {
        ffmpeg = pkgs.ffmpeg-headless;
        dependencyGroups = [
          "cli"
          "pty"
          "mcp"
          "acp"
          "web"
          "messaging"
        ];
      };

      settings = {
        gateway = {
          host = "::";
          port = 8080;
        };

        model = {
          default = "gpt-5.5";
          provider = "openai-codex";
          base_url = "https://chatgpt.com/backend-api/codex";
        };

        approvals.mode = "off";
        security = {
          tirith_enabled = false;
          redact_secrets = false;
        };
        terminal.backend = "local";

        platforms.telegram.extra = { };
      };
    };

    bash = {
      enable = true;
      initExtra = ''[[ "$PWD" == "/" ]] && cd'';
      shellAliases = {
        ll = "ls -la";
      };
    };

    tmux = {
      enable = true;
      terminal = "screen-256color";
    };
  };
}
