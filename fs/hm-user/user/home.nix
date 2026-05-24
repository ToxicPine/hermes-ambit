{ pkgs, ... }:

let
  sources = import ./npins;

  unstable = import sources.nixpkgs-unstable {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfree = true;
  };

  flake-compat = import sources.flake-compat;
  hermes-agent = (flake-compat { src = sources.hermes-agent; }).defaultNix;
in
{
  imports = [ (import ../../hm-base { inherit sources; }) ];

  home.packages = [
    unstable.codex
  ];

  programs.hermes-agent = {
    enable = true;

    package = hermes-agent.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
      extraDependencyGroups = [
        "messaging"
        "voice"
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
        openai_runtime = "codex_app_server";
      };

      stt = {
        provider = "local";
        local.model = "base";
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
