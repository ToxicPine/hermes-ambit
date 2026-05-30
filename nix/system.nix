{
  pkgs,
  ...
}:

{
  imageName = "container-agent";

  entrypoint = {
    user = "user";
    command = [
      "env"
      "SCRAMJET_HOST=0.0.0.0"
      "SCRAMJET_PORT=4096"
      "nestail"
    ];
    port = 4096;
  };

  spawnables = [
    {
      name = "hermes-gateway";
      command = [
        "hermes"
        "gateway"
      ];
      user = "user";
    }
    {
      name = "nix-gc";
      command = [ "/opt/app/bin/nix-gc-loop" ];
    }
    {
      name = "codex-remote-control";
      command = [
        "codex"
        "remote-control"
      ];
      user = "user";
    }
  ];

  packages = with pkgs; [
    bzip2
    diffutils
    file
    findutils
    gawk
    gnugrep
    gnused
    gnutar
    gzip
    inetutils
    less
    ncurses
    openssl
    procps
    psmisc
    ripgrep
    rsync
    snooze
    tree
    unzip
    which
    xz
    zip
  ];
}
