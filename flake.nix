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
          main = main.packages.${system}.default;
        };

      mkDevShells =
        system: let pkgs = pkgsFor system; in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixfmt-rfc-style
              nil
              npins
              ripgrep
            ];
          };
        };
      
      mkMainPackages =
        system: {
          default = self.packages.${system}.container;
          container = container system;
        };

    in {
      packages = forAllSystems mkMainPackages;
      devShells = forAllSystems mkDevShells;
    };
}
