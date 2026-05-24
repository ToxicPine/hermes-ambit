{
  pkgs,
  home-manager,
  userConfig,
  hmPolicy ? { },
  hmExtraSpecialArgs ? { },
}:

let
  inherit (pkgs) lib;
  inherit (lib) types mkOption;

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
    options.hmPolicy = mkOption {
      type = policyType;
      default = { };
    };
  };

  policy =
    (lib.evalModules {
      modules = [
        schemaModule
        { config.hmPolicy = hmPolicy; }
      ];
    }).config.hmPolicy;

  mkHome =
    name:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs = hmExtraSpecialArgs;
      modules = [
        ../fs/hm-user/${name}/home.nix
        {
          home.username = name;
          home.homeDirectory = "/home/${name}";
        }
      ];
    };

  homeConfig = lib.mapAttrs (name: _: mkHome name) userConfig;

  prebuiltActivations =
    if policy.buildProfiles then lib.mapAttrs (_: hc: hc.activationPackage) homeConfig else { };
in

{
  runtime = {
    contents = lib.attrValues prebuiltActivations;
    trees = { };

    files = {
      "/etc/home-manager-activations.json" = pkgs.writeText "home-manager-activations.json" (
        builtins.toJSON (lib.mapAttrs (_: pkg: "${pkg}") prebuiltActivations)
      );

      "/etc/home-manager-policy.json" = pkgs.writeText "home-manager-policy.json" (
        builtins.toJSON policy
      );
    };
  };
}
