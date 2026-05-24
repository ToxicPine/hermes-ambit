{
  homeManagerLib,
  pkgs,
  users,
  homeManagerPolicy ? { },
  extraSpecialArgs ? { },
  hmRoot ? ../fs/users,
}:

let
  lib = pkgs.lib;
  inherit (lib) types mkOption;

  userType = types.submodule {
    options = {
      uid = mkOption { type = types.int; };
      hm = mkOption {
        type = types.nullOr types.unspecified;
        default = null;
      };
    };
  };

  policyType = types.submodule {
    options = {
      buildProfiles = mkOption {
        type = types.bool;
        default = true;
      };
      activateOnBoot = mkOption {
        type = types.bool;
        default = true;
      };
      rebuildOnBoot = mkOption {
        type = types.bool;
        default = false;
      };
    };
  };

  schemaModule = {
    options = {
      users = mkOption { type = types.attrsOf userType; };
      homeManagerPolicy = mkOption {
        type = policyType;
        default = { };
      };
      extraSpecialArgs = mkOption {
        type = types.attrsOf types.unspecified;
        default = { };
      };
    };
  };

  eval = lib.evalModules {
    modules = [
      schemaModule
      { config = { inherit users homeManagerPolicy extraSpecialArgs; }; }
    ];
  };

  cfg = eval.config;

  normalizeHmSpec =
    username:
    let
      user = cfg.users.${username};
      hmField = if user.hm != null then user.hm else hmRoot + "/${username}";
      raw =
        if builtins.isFunction hmField then
          hmField {
            inherit
              username
              user
              pkgs
              homeManagerLib
              ;
            extraSpecialArgs = cfg.extraSpecialArgs;
          }
        else
          hmField;
    in
    if builtins.isPath raw || builtins.isString raw then
      {
        source = raw;
        modules = null;
        extraSpecialArgs = { };
      }
    else
      {
        modules = null;
        extraSpecialArgs = { };
      }
      // raw;

  hmSpecs = lib.mapAttrs (name: _: normalizeHmSpec name) cfg.users;

  mkHome =
    username:
    let
      hmSpec = hmSpecs.${username};
      baseModules = if hmSpec.modules != null then hmSpec.modules else [ "${hmSpec.source}/home.nix" ];
    in
    homeManagerLib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs = cfg.extraSpecialArgs // hmSpec.extraSpecialArgs;
      modules = baseModules ++ [
        {
          home.username = username;
          home.homeDirectory = "/home/${username}";
        }
      ];
    };

  homeConfigurations = lib.mapAttrs (name: _: mkHome name) cfg.users;

  prebuiltActivations =
    if cfg.homeManagerPolicy.buildProfiles then
      lib.mapAttrs (_: hc: hc.activationPackage) homeConfigurations
    else
      { };
in

{
  inherit homeConfigurations;

  runtime = {
    contents = lib.attrValues prebuiltActivations;
    trees = { };

    files = {
      "/etc/home-manager-activations.json" = pkgs.writeText "home-manager-activations.json" (
        builtins.toJSON (lib.mapAttrs (_: pkg: "${pkg}") prebuiltActivations)
      );

      "/etc/home-manager-policy.json" = pkgs.writeText "home-manager-policy.json" (
        builtins.toJSON cfg.homeManagerPolicy
      );
    };
  };
}
