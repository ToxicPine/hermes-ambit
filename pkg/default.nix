{
  writeShellApplication,
}:

writeShellApplication {
  name = "hermes-ambit-app";

  text = ''
    echo "hermes-ambit app"
  '';
}
