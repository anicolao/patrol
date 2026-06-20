{
  description = "Patrol development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          patrolRevisionEnv = ''
            export PATROL_GIT_REVISION="''${PATROL_GIT_REVISION:-$(git rev-parse --short HEAD 2>/dev/null || true)}"
            export VITE_PATROL_GIT_REVISION="''${VITE_PATROL_GIT_REVISION:-$PATROL_GIT_REVISION}"
          '';
          patrol-go2rtc-config = pkgs.writeShellApplication {
            name = "patrol-go2rtc-config";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/write-go2rtc-config.mjs
            '';
          };
          patrol-go2rtc-start = pkgs.writeShellApplication {
            name = "patrol-go2rtc-start";
            runtimeInputs = [
              pkgs.git
              pkgs.go2rtc
              pkgs.nodejs_24
            ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/start-go2rtc.mjs
            '';
          };
          patrol-go2rtc-observe = pkgs.writeShellApplication {
            name = "patrol-go2rtc-observe";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/observe-go2rtc.mjs
            '';
          };
          patrol-annke-events = pkgs.writeShellApplication {
            name = "patrol-annke-events";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/observe-annke-events.mjs
            '';
          };
          patrol-events-ws = pkgs.writeShellApplication {
            name = "patrol-events-ws";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/event-websocket-server.mjs
            '';
          };
          patrol-recorder = pkgs.writeShellApplication {
            name = "patrol-recorder";
            runtimeInputs = [
              pkgs.git
              pkgs.ffmpeg
              pkgs.nodejs_24
            ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/start-recorder.mjs
            '';
          };
          patrol-watchdog = pkgs.writeShellApplication {
            name = "patrol-watchdog";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/watchdog.mjs
            '';
          };
          patrol-watchdog-cron-install = pkgs.writeShellApplication {
            name = "patrol-watchdog-cron-install";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/install-watchdog-cron.mjs
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.ffmpeg
              pkgs.gh
              pkgs.git
              pkgs.go2rtc
              pkgs.nodejs_24
              patrol-annke-events
              patrol-events-ws
              patrol-go2rtc-config
              patrol-go2rtc-observe
              patrol-go2rtc-start
              patrol-recorder
              patrol-watchdog
              patrol-watchdog-cron-install
            ];
          };
        });
    };
}
