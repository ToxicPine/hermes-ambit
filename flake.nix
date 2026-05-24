{
  description = "Private Codex remote-control image";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hermes-agent.url = "github:NousResearch/hermes-agent";
    direnv-instant = {
      url = "github:Mic92/direnv-instant";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:

    let
      system = "x86_64-linux";
      pkgs = inputs.nixpkgs.legacyPackages.${system};
      pkgs-unstable = inputs.nixpkgs-unstable.legacyPackages.${system};
    in

    let
      userConfig = {
        user = {
          uid = 1000;
        };
      };

      systemConfig = import ./system.nix { inherit pkgs pkgs-unstable; };
    in

    let
      homeManagerPolicy = {
        buildProfiles = true;
        activateOnBoot = true;
        rebuildOnBoot = false;
      };

      hm = import ./lib/hm.nix {
        inherit pkgs homeManagerPolicy;
        users = userConfig;
        homeManagerLib = inputs.home-manager.lib;
        extraSpecialArgs = {
          inherit inputs pkgs-unstable;
          baseHomeModule = ./fs/nix/base/default.nix;
        };
      };
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ system ];

      perSystem =
        { ... }:
        {
          packages.default = import ./lib/image.nix {
            inherit pkgs;
            users = userConfig;
            inherit (hm) runtime;
            system = systemConfig;
          };
        };
    };
}
