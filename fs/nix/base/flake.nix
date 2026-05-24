{
  description = "Base Home Manager module for the private Codex image";

  outputs =
    { self }:
    {
      homeModules.default = import ./default.nix;
    };
}
