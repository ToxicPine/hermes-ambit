{
  bun,
  bun2nix,
  lib,
  makeWrapper,
  stdenv,
  ...
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  localBuildDirs = [
    ".cache"
    ".turbo"
    "dist"
    "dist-bin"
    "node_modules"
  ];
  sourceFilter =
    name: type:
    lib.cleanSourceFilter name type
    && !(type == "directory" && builtins.elem (baseNameOf name) localBuildDirs);
in
stdenv.mkDerivation {
  pname = "hermes-ambit";
  inherit (packageJson) version;

  src = lib.cleanSourceWith {
    src = ./.;
    filter = sourceFilter;
  };

  nativeBuildInputs = [
    bun2nix.hook
    makeWrapper
  ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };

  bunInstallFlags = [
    "--linker=isolated"
    "--production"
  ];

  doCheck = false;
  dontRunLifecycleScripts = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    bun run packages/tui/scripts/build-cli.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist-bin/hermes-ambit.js $out/lib/hermes-ambit/hermes-ambit.js
    install -Dm755 dist-bin/hermes-ambit-gcp.js $out/lib/hermes-ambit/hermes-ambit-gcp.js
    install -Dm755 dist-bin/hermes-ambit-azure.js $out/lib/hermes-ambit/hermes-ambit-azure.js
    makeWrapper ${bun}/bin/bun $out/bin/hermes-ambit \
      --add-flags "$out/lib/hermes-ambit/hermes-ambit.js"
    makeWrapper ${bun}/bin/bun $out/bin/hermes-ambit-gcp \
      --add-flags "$out/lib/hermes-ambit/hermes-ambit-gcp.js"
    makeWrapper ${bun}/bin/bun $out/bin/hermes-ambit-azure \
      --add-flags "$out/lib/hermes-ambit/hermes-ambit-azure.js"
    runHook postInstall
  '';

}
