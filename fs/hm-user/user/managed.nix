{ lib, ... }:
{
  programs.hermes-agent.settings.skills.platform_disabled.telegram = [
    "hermes-agent-skill-authoring"
  ];
}
