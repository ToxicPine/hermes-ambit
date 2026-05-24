# fs/hermes — lightweight HM-module library for the Hermes Agent.
#
# Public surface:
#   { hmModule }
#
# Consume from flake.nix:
#   hermes = import ./fs/hermes { inherit (inputs) hermes-agent; };
#   # ...then pass hermes.hmModule into HM via hmExtraSpecialArgs.

{ hermes-agent }:

{
  hmModule = import ./hm-module.nix { inherit hermes-agent; };
}
