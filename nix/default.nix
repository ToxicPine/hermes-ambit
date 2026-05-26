{
  system ? "x86_64-linux",
  sources ? import ../fs/hm-base/npins,
  app ? null,
}:

let
  pkgs = import sources.nixpkgs { inherit system; };
  home-manager = import sources.home-manager { inherit pkgs; };

  baseSystemConfig = import ./system.nix { inherit pkgs; };
  systemConfig = baseSystemConfig // {
    packages = baseSystemConfig.packages ++ pkgs.lib.optional (app != null) app;
  };
  userConfig = {
    user = {
      uid = 1000;
    };
  };

  hmPolicy = {
    buildProfiles = true;
    activateOnBoot = true;
    rebuildOnBoot = false;
  };

  hm = import ../lib/hm.nix {
    inherit
      pkgs
      home-manager
      userConfig
      hmPolicy
      ;
  };
in
import ../lib/image.nix {
  inherit pkgs;
  users = userConfig;
  inherit (hm) runtime;
  system = systemConfig;
}
