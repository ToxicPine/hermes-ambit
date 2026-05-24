{
  pkgs,
  ...
}:

{
  imageName = "hermes-gateway";

  entrypoint = {
    user = "user";
    command = [
      "hermes"
      "gateway"
    ];
    port = 8080;
  };

  spawnables = [ ];

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
    tree
    unzip
    which
    xz
    zip
  ];
}
