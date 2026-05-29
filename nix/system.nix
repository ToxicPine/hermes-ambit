{
  pkgs,
  ...
}:

{
  imageName = "container-agent";

  entrypoint = {
    user = "user";
    command = [
      "hermes"
      "gateway"
    ];
    port = 8080;
  };

  spawnables = [
    {
      name = "nix-gc";
      command = [ "/opt/app/bin/nix-gc-loop" ];
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
