{
  description = "Home Manager configuration for user";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    direnv-instant = {
      url = "github:Mic92/direnv-instant";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
    };
    flake-parts.url = "github:hercules-ci/flake-parts";
    hermes-agent.url = "github:NousResearch/hermes-agent";
    base.url = "path:../../nix/base";
  };

  outputs =
    inputs@{
      self,
      base,
      home-manager,
      nixpkgs,
      nixpkgs-unstable,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      pkgs-unstable = nixpkgs-unstable.legacyPackages.${system};
    in
    {
      homeConfigurations.user = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = {
          inherit inputs pkgs-unstable;
          baseHomeModule = base.homeModules.default;
        };
        modules = [
          ./home.nix
          {
            home.username = "user";
            home.homeDirectory = "/home/user";
          }
        ];
      };
    };
}
