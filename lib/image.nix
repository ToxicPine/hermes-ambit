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

  appPrefix = "/opt/app";
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

  installTree = src: dest: ''
    mkdir -p ${dest}
    cp -R ${src}/. ${dest}/
    if [ -d ${dest}/bin ]; then
      chmod 0755 ${dest}/bin
      find ${dest}/bin -type f -exec chmod 0755 {} +
    fi
  '';
in

pkgs.dockerTools.buildLayeredImageWithNixDb {
  name = cfg.system.imageName;
  tag = "latest";
  maxLayers = 125;

  contents = lib.unique (
    [
      pkgs.dockerTools.binSh
      pkgs.dockerTools.caCertificates
      pkgs.bashInteractive
      pkgs.util-linux
      pkgs.coreutils
      pkgs.nix
      pkgs.git
      pkgs.jq
    ]
    ++ cfg.system.packages
    ++ cfg.runtime.contents
  );

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
    substituters = file:///data/nix-cache?trusted=true https://cache.nixos.org/
    EOF
    mkdir -p nix/var/nix/daemon-socket
    mkdir -p usr/bin
    ln -s ${pkgs.coreutils}/bin/env usr/bin/env

    ${installTree ./fs appPrefix}
    ${installTree ../fs appPrefix}

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
    Entrypoint = [ "${appPrefix}/bin/entrypoint" ];
    Env = [
      "PATH=/bin:/sbin:/usr/bin:/usr/sbin"
      "NIX_PAGER=cat"
      "HOME=/root"
    ];
    ExposedPorts = {
      "${toString cfg.system.entrypoint.port}/tcp" = { };
    };
    Volumes = {
      "/data" = { };
    };
  };
}
