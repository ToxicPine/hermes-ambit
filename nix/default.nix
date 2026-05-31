{
  system ? "x86_64-linux",
  sources ? import ../fs/hm-base/npins,
}:

let
  pkgs = import sources.nixpkgs {
    localSystem.system = system;
    config.allowUnfree = true;
  };
  home-manager = import sources.home-manager { inherit pkgs; };

  systemConfig = import ./system.nix { inherit pkgs; };

  userConfig = {
    user = {
      uid = 1000;
    };
  };

  hm = import ../lib/hm.nix {
    inherit
      pkgs
      home-manager
      userConfig
      ;
  };
in
import ../lib/image.nix {
  inherit pkgs;
  users = userConfig;
  inherit (hm) runtime;
  system = systemConfig;
}
