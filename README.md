# hermes-ambit

A self-improving computer environment for self-improving agents.

## One-Liner

> This is a cloud-based container system, built for Hermes Agent, that can self-upgrade and adapt to your agent while it runs. The agent can edit a system configuration file from inside its container to modify the container it is running within.

Technically, this is mostly thanks to Nix and Home Manager.

## Why This Exists

Agents like Hermes can intentionally edit their own config and memory files while they run, adapting themselves to the user and improving their behavior over time. However, this is only part of the picture: because the agent acts by running commands on your computer, system-level details matter too. If it wants to process video, for example, it needs `ffmpeg` installed somewhere it can run it.

On your own machine, installing `ffmpeg` changes the same system the agent is already using, and that change sticks. But your machine can go offline, so you may want the agent running in the cloud. In a cloud container, the agent only sees what was included when the image was built. If `ffmpeg` was not included, the agent cannot reliably bring it into the system on its own; you usually have to rebuild and redeploy the image, with no way to make, view, or undo system changes on the fly.

`hermes-ambit` lets an agent improve itself in the cloud by making the container around it safely editable too.

## Quick Start

With Docker:

```sh
nix build .#default
docker load < result
docker run -v hermes-data:/data -p 8080:8080 hermes-gateway:latest
```

You can edit the default Hermes Agent settings via `hm/user/home.nix`. For Hermes Agent set-up, see `docs/HERMES.md`.

If you want to deploy `hermes-ambit` on the cloud, see `DEPLOYMENT.md`.

## Features

- The important stuff lives on `/data`, not inside the throwaway part of the container. That is why files, credentials, agent state, etc, survive restarts.
- The agent has a config file it can edit from inside the container: `~/.nixcfg/home.nix`. After editing it, `rebuild` applies the new tools and settings.
- The default tools are already in the image, so the container can start without waiting for a big install step.
- When `rebuild` finishes, its results are saved in `/data/nix-cache`. If the agent asks for the same tools again, they can be reused from that cache.
- `hmPolicy` decides what happens on startup: use the ready-cached environment, rebuild from the saved config, or leave the user environment alone.
- Each agent can run as a separate Linux user with its own home directory, configuration, installed tools, and unique uid.

## Architecture

The container has a read-only layer and a changeable layer. The read-only layer is the image you build: `system.nix` sets the shared packages, fixed background processes, main process, and exposed port, while `flake.nix` declares which users exist. The changeable layer is per user: each user gets `fs/hm-user/<name>/home.nix`, which becomes `~/.nixcfg/home.nix` inside the running container and controls that user's tools, shell settings, and Hermes settings.

In `system.nix`, the entrypoint is the main command for the container. If it exits, the container is done. A daemon is a background command started before the entrypoint:

```nix
{
  packages = with pkgs; [ ripgrep rsync tree ];
  daemons = [
    { name = "worker"; command = [ "my-worker" ]; user = "user"; }
  ];
  entrypoint = {
    user = "user";
    command = [ "hermes" "gateway" ];
    port = 8080;
  };
}
```

In `flake.nix`, users are just named accounts with stable uids:

```nix
userConfig = {
  user.uid = 1000;
};
```

Inside the running container, that user's config appears at `~/.nixcfg`. The agent can edit `~/.nixcfg/home.nix`, then run `rebuild` to apply it:

```nix
{
  home.packages = with pkgs; [ ffmpeg jq ];
  programs.bash.shellAliases.ll = "ls -la";
  programs.hermes-agent.settings.gateway.port = 8080;
}
```
