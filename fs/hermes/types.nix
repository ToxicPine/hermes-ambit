# fs/hermes/types.nix — option types isomorphic to upstream hermes-agent.
#
# Copied (with minimal touch-up) from
#   github:NousResearch/hermes-agent//nix/nixosModules.nix
# so that programs.hermes-agent.{settings,mcpServers} accept the same shapes
# as services.hermes-agent.{settings,mcpServers} upstream. Keep this file
# narrow — types only, no logic — so re-syncing against upstream is mechanical.

{ lib }:

let
  isOverride =
    value:
    builtins.isAttrs value
    && value ? _type
    && value._type == "override"
    && value ? priority
    && value ? content;

  flattenConfig =
    order: priority: path: value:
    if isOverride value then
      flattenConfig order value.priority path value.content
    else if builtins.isAttrs value && value != { } then
      lib.flatten (
        lib.mapAttrsToList (name: nested: flattenConfig order priority (path ++ [ name ]) nested) value
      )
    else
      [
        {
          inherit
            order
            path
            priority
            value
            ;
        }
      ];

  preferredDefinition =
    current: candidate:
    if
      current == null
      || candidate.priority < current.priority
      || (candidate.priority == current.priority && candidate.order > current.order)
    then
      candidate
    else
      current;

  mergeDeepConfig =
    defs:
    let
      indexedDefs = lib.imap0 (order: def: flattenConfig order 100 [ ] def.value) defs;
      flattened = lib.flatten indexedDefs;
      selected = lib.foldl' (
        acc: definition:
        acc
        // {
          ${lib.concatStringsSep "." definition.path} =
            preferredDefinition (acc.${lib.concatStringsSep "." definition.path} or null)
              definition;
        }
      ) { } flattened;
    in
    lib.foldl' (
      acc: definition: lib.recursiveUpdate acc (lib.setAttrByPath definition.path definition.value)
    ) { } (lib.attrValues selected);
in
{
  # Deep-merge attrset type used for `settings`. Module definitions merge
  # recursively while honoring nested `lib.mkForce`/`lib.mkOverride` priorities.
  deepConfigType = lib.types.mkOptionType {
    name = "hermes-config-attrs";
    description = "Hermes YAML config (attrset), merged deeply with nested override priority support.";
    check = builtins.isAttrs;
    merge = _loc: mergeDeepConfig;
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
