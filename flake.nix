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
          patrol-go2rtc-config = pkgs.writeShellApplication {
            name = "patrol-go2rtc-config";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              node scripts/write-go2rtc-config.mjs
            '';
          };
          patrol-go2rtc-start = pkgs.writeShellApplication {
            name = "patrol-go2rtc-start";
            runtimeInputs = [
              pkgs.go2rtc
              pkgs.nodejs_24
            ];
            text = ''
              node scripts/start-go2rtc.mjs
            '';
          };
          patrol-go2rtc-observe = pkgs.writeShellApplication {
            name = "patrol-go2rtc-observe";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              node scripts/observe-go2rtc.mjs
            '';
          };
          patrol-annke-events = pkgs.writeShellApplication {
            name = "patrol-annke-events";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              node scripts/observe-annke-events.mjs
            '';
          };
          patrol-events-ws = pkgs.writeShellApplication {
            name = "patrol-events-ws";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              node scripts/event-websocket-server.mjs
            '';
          };
          patrol-recorder = pkgs.writeShellApplication {
            name = "patrol-recorder";
            runtimeInputs = [
              pkgs.ffmpeg
              pkgs.nodejs_24
            ];
            text = ''
              node scripts/start-recorder.mjs
            '';
          };
          patrol-person-recognizer = pkgs.writeShellApplication {
            name = "patrol-person-recognizer";
            runtimeInputs = [
              pkgs.ffmpeg
              pkgs.nodejs_24
            ];
            text = ''
              node scripts/recognize-persons.mjs
            '';
          };
          patrol-watchdog = pkgs.writeShellApplication {
            name = "patrol-watchdog";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              node scripts/watchdog.mjs
            '';
          };
          patrol-watchdog-cron-install = pkgs.writeShellApplication {
            name = "patrol-watchdog-cron-install";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
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
              patrol-person-recognizer
              patrol-recorder
              patrol-watchdog
              patrol-watchdog-cron-install
            ];
          };
        });
    };
}
