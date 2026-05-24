{ baseHomeModule, ... }:

{
  imports = [
    baseHomeModule
  ];

  programs.hermes-agent = {
    enable = true;
    settings = {
      model.default = "anthropic/claude-sonnet-4";
      gateway = {
        host = "0.0.0.0";
        port = 8080;
      };
    };
  };
}
