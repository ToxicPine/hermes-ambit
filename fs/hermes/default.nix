# fs/hermes — package + HM-module library for the Hermes Agent.

{
  pkgs,
  sources ? import ../hm-base/npins,
  package ? import ./package.nix { inherit pkgs sources; },
}:

{
  inherit package;

  hmModule = import ./hm-module.nix { inherit package; };
}
