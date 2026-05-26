{
  description = "hermes-ambit";

  inputs = {
    main.url = "path:./pkg";
  };

  outputs = { self, main }:
    let
      systems = [ "x86_64-linux" ];

      forAllSystems = f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );

      sources = import ./fs/hm-base/npins;
      pkgsFor = system: import sources.nixpkgs { inherit system; };

      container =
        system:
        import ./nix {
          inherit system sources;
        };

      mkDevShells =
        system: let pkgs = pkgsFor system; in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nixfmt-rfc-style
              nil
              nodejs
              npins
              ripgrep
              typescript
            ];
          };
        };
      
      mkMainPackages =
        system: {
          default = self.packages.${system}.container;
          container = container system;
          deployer = main.packages.${system}.default;
        };

    in {
      packages = forAllSystems mkMainPackages;
      devShells = forAllSystems mkDevShells;
    };
}
