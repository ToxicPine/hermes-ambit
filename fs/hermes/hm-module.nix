# fs/hermes/hm-module.nix — Home Manager module for the Hermes Agent.
#
# Mirrors the option surface of upstream `services.hermes-agent.*`
# (github:NousResearch/hermes-agent//nix/nixosModules.nix) under
# `programs.hermes-agent.*`, so snippets from the upstream docs transfer by
# swapping `services` → `programs`. The systemd / Ubuntu-container halves of
# the upstream module have no analog in this single-process Fly container and
# are intentionally omitted:
#
#   stateDir, user, group, createUser, restart, restartSec,
#   addToSystemPackages, container.*, hostUsers, extraPackages,
#   extraPythonPackages, extraDependencyGroups, extraArgs
#
# `extraArgs` is omitted because plumbing it into the container's PID-1
# argv would force this user-scoped module to know which user owns the
# system entrypoint (and force the system layer to know about hermes).
# Either set arguments via the YAML config / settings, or override
# system.entrypoint.command at the flake level.
#
# `extraPythonPackages` / `extraDependencyGroups` are not lost — set them by
# overriding the package directly:
#
#     programs.hermes-agent.package =
#       hermes-agent.packages.${system}.default.override {
#         extraDependencyGroups = [ "hindsight" ];
#         extraPythonPackages   = [ ... ];
#       };
#
# The upstream `nix/hermes-agent.nix` derivation supports this natively.

{ hermes-agent }:

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.hermes-agent;

  inherit (import ./types.nix { inherit lib; }) deepConfigType mcpServerType;

  yaml = pkgs.formats.yaml { };

  # MCP server submodule entries → settings.mcp_servers attrset.
  # Logic copied verbatim from upstream nixosModules.nix lines 603–630.
  mcpFlat = lib.mapAttrs (
    _name: srv:
    # Stdio transport
    lib.optionalAttrs (srv.command != null) { inherit (srv) command args; }
    // lib.optionalAttrs (srv.env != { }) { inherit (srv) env; }
    # HTTP transport
    // lib.optionalAttrs (srv.url != null) { inherit (srv) url; }
    // lib.optionalAttrs (srv.headers != { }) { inherit (srv) headers; }
    # Auth
    // lib.optionalAttrs (srv.auth != null) { inherit (srv) auth; }
    # Enable / disable
    // {
      inherit (srv) enabled;
    }
    # Common options
    // lib.optionalAttrs (srv.timeout != null) { inherit (srv) timeout; }
    // lib.optionalAttrs (srv.connect_timeout != null) { inherit (srv) connect_timeout; }
    # Tool filtering
    // lib.optionalAttrs (srv.tools != null) {
      tools = lib.filterAttrs (_: v: v != [ ]) {
        inherit (srv.tools) include exclude;
      };
    }
    # Sampling
    // lib.optionalAttrs (srv.sampling != null) {
      sampling = lib.filterAttrs (_: v: v != null && v != [ ]) {
        inherit (srv.sampling)
          enabled
          model
          max_tokens_cap
          timeout
          max_rpm
          max_tool_rounds
          allowed_models
          log_level
          ;
      };
    }
  ) cfg.mcpServers;

  mergedSettings =
    let
      withMcp = lib.optionalAttrs (cfg.mcpServers != { }) { mcp_servers = mcpFlat; };
    in
    lib.recursiveUpdate withMcp cfg.settings;

  generatedConfigFile = yaml.generate "hermes-config.yaml" mergedSettings;
  effectiveConfigFile = if cfg.configFile != null then cfg.configFile else generatedConfigFile;

  # documents → store tree under workspace/. Mirrors upstream's documentDerivation
  # (nixosModules.nix lines 56–67) but builds a flat directory we feed into
  # home.file entries below.
  documentTree = pkgs.runCommand "hermes-documents" { } (
    ''
      mkdir -p $out
    ''
    + lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        name: value:
        if builtins.isPath value || lib.isStorePath value then
          "cp ${value} $out/${name}"
        else
          "cat > $out/${name} <<'HERMES_DOC_EOF'\n${value}\nHERMES_DOC_EOF"
      ) cfg.documents
    )
  );

  documentFiles = lib.mapAttrs' (
    name: _:
    lib.nameValuePair
      (lib.removePrefix "${config.home.homeDirectory}/" "${cfg.workingDirectory}/${name}")
      { source = "${documentTree}/${name}"; }
  ) cfg.documents;

  pluginFiles = lib.listToAttrs (
    map (
      p: lib.nameValuePair ".hermes/plugins/nix-managed-${lib.getName p}" { source = p; }
    ) cfg.extraPlugins
  );

in
{
  options.programs.hermes-agent = {
    enable = lib.mkEnableOption "Hermes Agent gateway";

    package = lib.mkOption {
      type = lib.types.package;
      default = hermes-agent.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "hermes-agent.packages.\${system}.default";
      description = ''
        Hermes Agent package. Override to add Python deps:
          programs.hermes-agent.package =
            hermes-agent.packages.''${system}.default.override {
              extraDependencyGroups = [ "hindsight" ];
            };
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to an existing config.yaml. If set, takes precedence over the
        declarative `settings` option (and `mcpServers` is ignored — the
        file is installed verbatim).
      '';
    };

    settings = lib.mkOption {
      type = deepConfigType;
      default = { };
      description = ''
        Declarative Hermes config (attrset). Deep-merged across module
        definitions and rendered as $HERMES_HOME/config.yaml.
      '';
      example = lib.literalExpression ''
        {
          model.default = "anthropic/claude-sonnet-4";
          gateway = { host = "0.0.0.0"; port = 8080; };
          terminal.backend = "local";
        }
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Non-secret environment variables. Written into $HERMES_HOME/.env at
        activation. Do NOT put secrets here — use environmentFiles or pass
        them through the container's process environment (Fly secrets).
      '';
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Paths to environment files (in-container) whose contents are
        concatenated into $HERMES_HOME/.env at activation. Hermes reads .env
        at startup via load_hermes_dotenv().
      '';
    };

    documents = lib.mkOption {
      type = lib.types.attrsOf (lib.types.either lib.types.str lib.types.path);
      default = { };
      description = ''
        Workspace files (SOUL.md, USER.md, etc.). Keys are filenames, values
        are inline strings or paths. Installed into workingDirectory.
      '';
      example = lib.literalExpression ''
        {
          "SOUL.md" = "You are a helpful AI assistant.";
          "USER.md" = ./documents/USER.md;
        }
      '';
    };

    mcpServers = lib.mkOption {
      type = lib.types.attrsOf mcpServerType;
      default = { };
      description = ''
        MCP server configurations. Flattened into settings.mcp_servers in
        the rendered config.yaml. Each server uses stdio (command/args) or
        HTTP (url) transport.
      '';
      example = lib.literalExpression ''
        {
          filesystem = {
            command = "npx";
            args = [ "-y" "@modelcontextprotocol/server-filesystem" "/home/user/workspace" ];
          };
          remote-oauth = {
            url = "https://mcp.example.com/mcp";
            auth = "oauth";
          };
        }
      '';
    };

    extraPlugins = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = ''
        Directory-based plugin packages, symlinked into
        $HERMES_HOME/plugins/nix-managed-<name>. Each package should contain
        a plugin.yaml at its root.
      '';
    };

    authFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to an auth.json seed file (OAuth credentials). Installed to
        $HERMES_HOME/auth.json. By default only seeded if absent.
      '';
    };

    authFileForceOverwrite = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Always overwrite auth.json from authFile on activation.";
    };

    workingDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/workspace";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/workspace"'';
      description = "Working directory for the agent (MESSAGING_CWD).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          let
            names = map lib.getName cfg.extraPlugins;
          in
          (lib.length names) == (lib.length (lib.unique names));
        message = "programs.hermes-agent.extraPlugins: duplicate plugin names. If using fetchFromGitHub, set name = \"plugin-name\" to disambiguate.";
      }
    ];

    home.packages = [ cfg.package ];

    home.sessionVariables = {
      HERMES_HOME = "${config.home.homeDirectory}/.hermes";
      HERMES_MANAGED = "true";
      MESSAGING_CWD = cfg.workingDirectory;
    };

    home.file = {
      ".hermes/config.yaml".source = effectiveConfigFile;
      ".hermes/.managed".text = "";
    }
    // documentFiles
    // pluginFiles;

    # .env rendered at activation. Container-level env vars (Fly secrets)
    # pass straight through to the hermes process via `env … hermes gateway`
    # in lib/fs/bin/entrypoint, so most deployments leave .env empty.
    home.activation.hermesEnvFile = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      install -d -m 0700 "$HOME/.hermes"
      umask 0177
      {
        :
        ${lib.concatStringsSep "\n" (
          lib.mapAttrsToList (
            k: v: "printf '%s=%s\\n' ${lib.escapeShellArg k} ${lib.escapeShellArg v}"
          ) cfg.environment
        )}
        ${lib.concatMapStringsSep "\n" (f: ''
          if [ -f ${lib.escapeShellArg f} ]; then
            cat ${lib.escapeShellArg f}
            printf '\n'
          fi
        '') cfg.environmentFiles}
      } > "$HOME/.hermes/.env"
      chmod 0600 "$HOME/.hermes/.env"
    '';

    home.activation.hermesAuth = lib.mkIf (cfg.authFile != null) (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        install -d -m 0700 "$HOME/.hermes"
        ${
          if cfg.authFileForceOverwrite then
            ''
              install -m 0600 ${cfg.authFile} "$HOME/.hermes/auth.json"
            ''
          else
            ''
              if [ ! -f "$HOME/.hermes/auth.json" ]; then
                install -m 0600 ${cfg.authFile} "$HOME/.hermes/auth.json"
              fi
            ''
        }
      ''
    );
  };
}
