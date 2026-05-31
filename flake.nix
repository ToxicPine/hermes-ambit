{
  description = "hermes-ambit";

  outputs =
    { self }:
    let
      systems = [ "x86_64-linux" ];

      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );

      sources = import ./fs/hm-base/npins;
      pkgsFor =
        system:
        import sources.nixpkgs {
          localSystem.system = system;
          config.allowUnfree = true;
        };

      container =
        system:
        import ./nix {
          inherit system sources;
        };

      mkDevShells =
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nixfmt
              nil
              nodejs
              npins
              ripgrep
              typescript
            ];
          };
        };

      mkMainPackages = system: {
        default = container system;
        container = container system;
      };

    in
    {
      packages = forAllSystems mkMainPackages;
      devShells = forAllSystems mkDevShells;
    };
}
