{
  pkgs,
  users,
  system,
  runtime ? { },
}:

let
  inherit (pkgs) lib;
  inherit (lib) types mkOption;

  userType = types.submodule {
    options = {
      uid = mkOption { type = types.int; };
    };
    freeformType = types.attrsOf types.unspecified;
  };

  spawnableType = types.submodule {
    options = {
      name = mkOption { type = types.str; };
      command = mkOption { type = types.listOf types.str; };
      user = mkOption {
        type = types.nullOr (types.either types.str (types.listOf types.str));
        default = null;
      };
    };
  };

  entrypointType = types.submodule {
    options = {
      user = mkOption { type = types.str; };
      command = mkOption { type = types.listOf types.str; };
      port = mkOption { type = types.port; };
    };
  };

  systemType = types.submodule {
    options = {
      imageName = mkOption { type = types.str; };
      packages = mkOption { type = types.listOf types.package; };
      spawnables = mkOption { type = types.listOf spawnableType; };
      entrypoint = mkOption { type = entrypointType; };
    };
  };

  runtimeType = types.submodule {
    options = {
      contents = mkOption {
        type = types.listOf types.package;
        default = [ ];
      };
      files = mkOption {
        type = types.attrsOf types.path;
        default = { };
      };
      trees = mkOption {
        type = types.attrsOf types.path;
        default = { };
      };
    };
  };

  schemaModule = {
    options = {
      users = mkOption { type = types.attrsOf userType; };
      system = mkOption { type = systemType; };
      runtime = mkOption {
        type = runtimeType;
        default = { };
      };
    };
  };

  eval = lib.evalModules {
    modules = [
      schemaModule
      { config = { inherit users system runtime; }; }
    ];
  };

  cfg = eval.config;

  assertAbsoluteKeys =
    label: attrs:
    let
      bad = lib.filter (k: !(lib.hasPrefix "/" k)) (lib.attrNames attrs);
    in
    if bad == [ ] then
      attrs
    else
      throw "lib/image.nix: ${label} keys must be absolute paths: ${lib.concatStringsSep ", " bad}";

  _filesChecked = assertAbsoluteKeys "runtime.files" cfg.runtime.files;
  _treesChecked = assertAbsoluteKeys "runtime.trees" cfg.runtime.trees;

  mutableConfigPrefix = "/opt/app";
  factorySettingsPrefix = "/opt/defaults";
  nixbldCount = 10;

  userList = lib.mapAttrsToList (name: u: {
    inherit name;
    inherit (u) uid;
  }) cfg.users;

  passwdFile = pkgs.writeText "passwd" (
    "root:x:0:0:root:/root:/bin/bash\n"
    + "sshd:x:65533:65533:sshd:/var/empty:/bin/false\n"
    + "nobody:x:65534:65534:nobody:/nonexistent:/bin/false\n"
    + lib.concatStringsSep "\n" (
      map (
        i:
        "nixbld${toString i}:x:${toString (30000 + i)}:30000:Nix build user ${toString i}:/var/empty:/bin/false"
      ) (lib.genList (i: i + 1) nixbldCount)
    )
    + "\n"
    + lib.concatStringsSep "\n" (
      map (u: "${u.name}:x:${toString u.uid}:${toString u.uid}::/home/${u.name}:/bin/bash") userList
    )
    + "\n"
  );

  groupFile = pkgs.writeText "group" (
    "root:x:0:\n"
    + "sshd:x:65533:\n"
    + "nixbld:x:30000:"
    + lib.concatStringsSep "," (map (i: "nixbld${toString i}") (lib.genList (i: i + 1) nixbldCount))
    + "\n"
    + "nobody:x:65534:\n"
    + lib.concatStringsSep "\n" (map (u: "${u.name}:x:${toString u.uid}:") userList)
    + "\n"
  );

  usersJson = pkgs.writeText "users.json" (builtins.toJSON userList);
  entrypointJson = pkgs.writeText "entrypoint.json" (builtins.toJSON cfg.system.entrypoint);
  spawnablesJson = pkgs.writeText "spawnables.json" (builtins.toJSON cfg.system.spawnables);

  normalizeDest =
    dest:
    if lib.hasPrefix "/" dest then builtins.substring 1 (builtins.stringLength dest - 1) dest else dest;

  installRuntimeFiles = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (dest: src: ''
      mkdir -p "$(${pkgs.coreutils}/bin/dirname "${normalizeDest dest}")"
      cp ${src} "${normalizeDest dest}"
    '') _filesChecked
  );

  installRuntimeTrees = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (dest: src: ''
      mkdir -p "${normalizeDest dest}"
      cp -R ${src}/. "${normalizeDest dest}/"
    '') _treesChecked
  );

  installTree = src: dest: noClobber: ''
    mkdir -p ${dest}
    cp -R ${if noClobber then "-n " else ""}${src}/. ${dest}/
    if [ -d ${dest}/bin ]; then
      chmod 0755 ${dest}/bin
      find ${dest}/bin -type f -exec chmod 0755 {} +
    fi
  '';

  fsBinNames = lib.attrNames (
    lib.filterAttrs (_name: type: type == "regular" || type == "symlink") (builtins.readDir ./fs/bin)
  );

  linkFsBins = lib.concatMapStringsSep "\n" (name: ''
    ln -s ${mutableConfigPrefix}/bin/${name} usr/bin/${name}
  '') fsBinNames;
in

let
  # Bootstrap contents land in the image's /nix/store as docker
  # layers, so the entrypoint can run before /nix-base is unpacked.
  # Everything else only lives in /nix-base and is materialized into
  # /nix/store on boot via `cp -an`, avoiding a double copy of the
  # full closure inside the image.
  # Anything the entrypoint / nix-gc-loop / refresh-system scripts need on
  # PATH (`/bin`, populated by docker layers) before /nix-base is
  # unpacked must live here. snooze is needed by nix-gc-loop on every
  # iteration, not just first boot.
  bootstrapContents = [
    pkgs.dockerTools.binSh
    pkgs.dockerTools.caCertificates
    pkgs.bashInteractive
    pkgs.util-linux
    pkgs.coreutils
    pkgs.nix
    pkgs.gnutar
    pkgs.gzip
    pkgs.jq
    pkgs.git
    pkgs.snooze
  ];

  imageContents = lib.unique (bootstrapContents ++ cfg.system.packages ++ cfg.runtime.contents);

  # The full closure of the image, materialized as a tarball rather
  # than a directory. Keeping this as one store output file avoids
  # exhausting inode-constrained builders while still letting the
  # entrypoint seed /data-backed /nix on every boot. The included db
  # registration lets nix-daemon learn about freshly-seeded paths after
  # an image upgrade.
  imageClosure = pkgs.closureInfo { rootPaths = imageContents; };
  nixBaseTar = pkgs.runCommand "nix-base.tar.gz" { nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ]; } ''
    : "''${out:?out must be set by runCommand}"
    mkdir -p root/var/nix
    cp ${imageClosure}/registration root/var/nix/db-base
    tar -czf "$out" -C root var/nix --transform='s|^/nix/||' -T ${imageClosure}/store-paths
  '';
in
pkgs.dockerTools.buildLayeredImageWithNixDb {
  name = cfg.system.imageName;
  tag = "latest";
  maxLayers = 125;

  contents = bootstrapContents;

  fakeRootCommands = ''
    mkdir -p etc/nixcfg etc/nix
    cp ${passwdFile} etc/passwd
    cp ${groupFile} etc/group
    cp ${usersJson} etc/users.json
    cp ${entrypointJson} etc/entrypoint.json
    cp ${spawnablesJson} etc/spawnables.json
    ${installRuntimeFiles}
    ${installRuntimeTrees}
    cat > etc/nsswitch.conf <<'EOF'
    passwd: files
    group: files
    hosts: files dns
    EOF
    cat > etc/nix/nix.conf <<'EOF'
    experimental-features = nix-command flakes
    sandbox = false
    build-dir = /data/nix/builds
    substituters = file:///data/nix-cache?trusted=true https://cache.nixos.org/
    EOF
    mkdir -p nix/var/nix/daemon-socket
    cp ${nixBaseTar} nix-base.tar.gz
    mkdir -p usr/bin
    ln -s ${pkgs.coreutils}/bin/env usr/bin/env
    ${linkFsBins}

    ${installTree ./fs mutableConfigPrefix false}
    ${installTree ../fs mutableConfigPrefix true}

    ${installTree ./fs factorySettingsPrefix false}
    ${installTree ../fs factorySettingsPrefix true}

    chmod -R a-w ${factorySettingsPrefix}

    ${lib.concatStringsSep "\n" (
      map (u: ''
        mkdir -p home/${u.name}
        chown ${toString u.uid}:${toString u.uid} home/${u.name}
      '') userList
    )}

    mkdir -p data root tmp var/empty
    chmod 1777 tmp
  '';
  enableFakechroot = true;

  config = {
    Entrypoint = [ "${mutableConfigPrefix}/bin/entrypoint" ];
    Env = [
      "PATH=/bin:/sbin:/usr/bin:/usr/sbin"
      "NIX_PAGER=cat"
      "TMPDIR=/data/tmp"
      "HOME=/root"
    ];
    ExposedPorts = {
      "${toString cfg.system.entrypoint.port}/tcp" = { };
    };
    Volumes = {
      "/data" = { };
      "/nix" = { };
    };
  };
}
