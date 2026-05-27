{ pkgs, ... }:

pkgs.writeShellApplication {
  name = "wghc";
  runtimeInputs = with pkgs; [
    coreutils
    gh
    git
  ];
  text = builtins.readFile ./wghc.sh;
}
