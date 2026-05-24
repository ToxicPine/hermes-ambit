# fs/hermes/types.nix — option types isomorphic to upstream hermes-agent.
#
# Copied (with minimal touch-up) from
#   github:NousResearch/hermes-agent//nix/nixosModules.nix
# so that programs.hermes-agent.{settings,mcpServers} accept the same shapes
# as services.hermes-agent.{settings,mcpServers} upstream. Keep this file
# narrow — types only, no logic — so re-syncing against upstream is mechanical.

{ lib }:

{
  # Deep-merge attrset type used for `settings`. Module definitions merge via
  # lib.recursiveUpdate, matching upstream behavior so multiple modules can
  # contribute nested config fragments without clobbering each other.
  deepConfigType = lib.types.mkOptionType {
    name = "hermes-config-attrs";
    description = "Hermes YAML config (attrset), merged deeply via lib.recursiveUpdate.";
    check = builtins.isAttrs;
    merge = _loc: defs: lib.foldl' lib.recursiveUpdate { } (map (d: d.value) defs);
  };

  # Submodule for each entry under `mcpServers`. Field set matches upstream
  # exactly so docs snippets transfer verbatim.
  mcpServerType = lib.types.submodule {
    options = {
      # ── Stdio transport ─────────────────────────────────────────────
      command = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "MCP server command (stdio transport).";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Command-line arguments (stdio transport).";
      };
      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Environment variables for the server process (stdio transport).";
      };

      # ── HTTP / StreamableHTTP transport ─────────────────────────────
      url = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "MCP server endpoint URL (HTTP/StreamableHTTP transport).";
      };
      headers = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "HTTP headers, e.g. for authentication (HTTP transport).";
      };

      # ── Authentication ──────────────────────────────────────────────
      auth = lib.mkOption {
        type = lib.types.nullOr (lib.types.enum [ "oauth" ]);
        default = null;
        description = ''
          Authentication method. Set to "oauth" for OAuth 2.1 PKCE flow
          (remote MCP servers). Tokens are stored in $HERMES_HOME/mcp-tokens/.
        '';
      };

      # ── Enable / disable ────────────────────────────────────────────
      enabled = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Enable or disable this MCP server.";
      };

      # ── Common options ──────────────────────────────────────────────
      timeout = lib.mkOption {
        type = lib.types.nullOr lib.types.int;
        default = null;
        description = "Tool call timeout in seconds (default: 120).";
      };
      connect_timeout = lib.mkOption {
        type = lib.types.nullOr lib.types.int;
        default = null;
        description = "Initial connection timeout in seconds (default: 60).";
      };

      # ── Tool filtering ──────────────────────────────────────────────
      tools = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              include = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Tool allowlist — only these tools are registered.";
              };
              exclude = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Tool blocklist — these tools are hidden.";
              };
            };
          }
        );
        default = null;
        description = "Filter which tools are exposed by this server.";
      };

      # ── Sampling (server-initiated LLM requests) ────────────────────
      sampling = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              enabled = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = "Enable sampling.";
              };
              model = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Override model for sampling requests.";
              };
              max_tokens_cap = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Max tokens per request.";
              };
              timeout = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "LLM call timeout in seconds.";
              };
              max_rpm = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Max requests per minute.";
              };
              max_tool_rounds = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Max tool-use rounds per sampling request.";
              };
              allowed_models = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Models the server is allowed to request.";
              };
              log_level = lib.mkOption {
                type = lib.types.nullOr (
                  lib.types.enum [
                    "debug"
                    "info"
                    "warning"
                  ]
                );
                default = null;
                description = "Audit log level for sampling requests.";
              };
            };
          }
        );
        default = null;
        description = "Sampling configuration for server-initiated LLM requests.";
      };
    };
  };
}
