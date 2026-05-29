{ pkgs, ... }:

let
  sources = import ./npins;
  pkgsUnstable = import sources.nixpkgs-unstable {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfree = true;
  };
in
{
  imports = [ (import ../../hm-base { inherit sources; }) ];

  home.packages = [ pkgsUnstable.codex ];

  programs.hermes-agent = {
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
        openai_runtime = "auto";
      };

      approvals.mode = "off";
      security = {
        tirith_enabled = false;
        redact_secrets = false;
      };
      terminal.backend = "local";

      # Telegram transport. Secrets (TELEGRAM_BOT_TOKEN,
      # TELEGRAM_ALLOWED_USERS, optional TELEGRAM_WEBHOOK_URL /
      # TELEGRAM_WEBHOOK_SECRET / TELEGRAM_HOME_CHANNEL) come through
      # the container process environment, not this file.
      platforms.telegram.extra = { };
    };
  };
}
