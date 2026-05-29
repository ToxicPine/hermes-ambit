{
  pkgs,
  sources ? import ../hm-base/npins,
}:

let
  inherit (pkgs) lib;

  flake-compat = import sources.flake-compat;
  upstream = (flake-compat { src = sources.hermes-agent; }).defaultNix;
  inputs = upstream.inputs;

  npm-lockfile-fix = pkgs.python312Packages.buildPythonApplication {
    pname = "npm-lockfile-fix";
    version = "0.1.0";

    pyproject = true;
    build-system = [ pkgs.python312Packages.setuptools ];
    dontwrapPythonPrograms = true;

    src = inputs.npm-lockfile-fix;

    doCheck = false;
    propagatedBuildInputs = with pkgs.python312Packages; [
      requests
      setuptools
    ];

    meta = {
      mainProgram = "npm-lockfile-fix";
      homepage = "https://github.com/jeslie0/npm-lockfile-fix";
      description = "Add missing integrity and resolved fields to a package-lock.json file.";
      license = lib.licenses.mit;
    };
  };

  defaultDependencyGroups = [
    "cli"
    "pty"
    "mcp"
    "acp"
    "web"
  ];

  mkHermesAgent =
    {
      dependencyGroups ? defaultDependencyGroups,
      ...
    }@args:
    let
      # Upstream's hermes-agent.nix hardcodes an additive group set when calling
      # python.nix. Intercept that internal call so this wrapper owns the exact
      # dependency group list.
      upstreamArgs = builtins.removeAttrs args [
        "dependencyGroups"
        "callPackage"
      ];

      callPackage =
        path: packageArgs:
        if lib.hasSuffix "/python.nix" (toString path) then
          pkgs.callPackage path (packageArgs // { dependency-groups = dependencyGroups; })
        else
          pkgs.callPackage path packageArgs;
    in
    pkgs.callPackage (sources.hermes-agent + "/nix/hermes-agent.nix") (
      {
        inherit (inputs) uv2nix pyproject-nix pyproject-build-systems;
        inherit npm-lockfile-fix;
        rev = upstream.rev or null;
      }
      // upstreamArgs
      // {
        inherit callPackage;
      }
    );
in
lib.makeOverridable mkHermesAgent { }
