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
          patrol-web = pkgs.writeShellApplication {
            name = "patrol-web";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              if [ -r .env.local ]; then
                set -a
                # shellcheck source=/dev/null
                . ./.env.local
                set +a
              fi
              npm run preview -- --host 0.0.0.0 --port 5184 --strictPort
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
              node --experimental-strip-types scripts/start-recorder.mjs
            '';
          };
          patrol-recording-catalog-sync = pkgs.writeShellApplication {
            name = "patrol-recording-catalog-sync";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node --experimental-strip-types scripts/sync-recording-catalog.mjs
            '';
          };
          patrol-thumbnailer = pkgs.writeShellApplication {
            name = "patrol-thumbnailer";
            runtimeInputs = [
              pkgs.ffmpeg
              pkgs.git
              pkgs.nodejs_24
            ];
            text = ''
              ${patrolRevisionEnv}
              node --experimental-strip-types scripts/generate-recording-thumbnails.mjs
            '';
          };
          patrol-recorder-launch-agent-install = pkgs.writeShellApplication {
            name = "patrol-recorder-launch-agent-install";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/install-recorder-launch-agent.mjs
            '';
          };
          patrol-service-launch-agents-install = pkgs.writeShellApplication {
            name = "patrol-service-launch-agents-install";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/install-service-launch-agents.mjs
            '';
          };
          patrol-person-recognizer = pkgs.writeShellApplication {
            name = "patrol-person-recognizer";
            runtimeInputs = [
              pkgs.ffmpeg
              pkgs.git
              pkgs.nodejs_24
            ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/recognize-persons.mjs
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
          patrol-state-checkpoint = pkgs.writeShellApplication {
            name = "patrol-state-checkpoint";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node --experimental-strip-types scripts/state-checkpoint.ts
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
          patrol-watchdog-launch-agent-install = pkgs.writeShellApplication {
            name = "patrol-watchdog-launch-agent-install";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              ${patrolRevisionEnv}
              node scripts/install-watchdog-launch-agent.mjs
            '';
          };
          patrol-branch-audit = pkgs.writeShellApplication {
            name = "patrol-branch-audit";
            runtimeInputs = [ pkgs.git pkgs.nodejs_24 ];
            text = ''
              node scripts/audit-branches.mjs "$@"
            '';
          };
          patrol-activate-hikvision-camera = pkgs.writeShellApplication {
            name = "patrol-activate-hikvision-camera";
            runtimeInputs = [
              pkgs.curl
              pkgs.nodejs_24
            ];
            text = ''
              node scripts/activate-hikvision-camera.mjs "$@"
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
              patrol-activate-hikvision-camera
              patrol-events-ws
              patrol-go2rtc-config
              patrol-go2rtc-observe
              patrol-go2rtc-start
              patrol-branch-audit
              patrol-person-recognizer
              patrol-recording-catalog-sync
              patrol-recorder
              patrol-recorder-launch-agent-install
              patrol-service-launch-agents-install
              patrol-state-checkpoint
              patrol-thumbnailer
              patrol-watchdog
              patrol-watchdog-cron-install
              patrol-watchdog-launch-agent-install
              patrol-web
            ];
          };
        });
    };
}
