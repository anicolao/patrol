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
          loadLocalEnv = ''
            if [ -f .env.local ]; then
              set -a
              # shellcheck source=/dev/null
              . ./.env.local
              set +a
            fi
          '';
          patrol-go2rtc-config = pkgs.writeShellApplication {
            name = "patrol-go2rtc-config";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
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
              ${loadLocalEnv}
              node scripts/start-go2rtc.mjs
            '';
          };
          patrol-go2rtc-observe = pkgs.writeShellApplication {
            name = "patrol-go2rtc-observe";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              node scripts/observe-go2rtc.mjs
            '';
          };
          patrol-annke-events = pkgs.writeShellApplication {
            name = "patrol-annke-events";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              node scripts/observe-annke-events.mjs
            '';
          };
          patrol-events-ws = pkgs.writeShellApplication {
            name = "patrol-events-ws";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              node scripts/event-websocket-server.mjs
            '';
          };
          patrol-web-start = pkgs.writeShellApplication {
            name = "patrol-web-start";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              npm run dev -- --host 0.0.0.0 --port 5184
            '';
          };
          patrol-recorder = pkgs.writeShellApplication {
            name = "patrol-recorder";
            runtimeInputs = [
              pkgs.ffmpeg
              pkgs.nodejs_24
            ];
            text = ''
              ${loadLocalEnv}
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
              ${loadLocalEnv}
              node scripts/recognize-persons.mjs
            '';
          };
          patrol-watchdog = pkgs.writeShellApplication {
            name = "patrol-watchdog";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              node scripts/watchdog.mjs
            '';
          };
          patrol-watchdog-cron-install = pkgs.writeShellApplication {
            name = "patrol-watchdog-cron-install";
            runtimeInputs = [ pkgs.nodejs_24 ];
            text = ''
              ${loadLocalEnv}
              node scripts/install-watchdog-cron.mjs
            '';
          };
          patrol-migrate-data = pkgs.writeShellApplication {
            name = "patrol-migrate-data";
            runtimeInputs = [
              pkgs.coreutils
              pkgs.rsync
            ];
            text = ''
              set -euo pipefail
              ${loadLocalEnv}

              if [ -z "''${PATROL_DATA_DIR:-}" ]; then
                echo "patrol-migrate-data: set PATROL_DATA_DIR in .env.local or the environment" >&2
                exit 1
              fi

              source_dir="''${PATROL_OLD_DATA_DIR:-$PWD/.patrol}"
              target="''${PATROL_DATA_DIR}"

              case "$target" in
                /Volumes/*)
                  volume=/Volumes/$(printf '%s\n' "''${target#/Volumes/}" | cut -d / -f 1)
                  if [ ! -d "$volume" ]; then
                    echo "patrol-migrate-data: $volume is not mounted" >&2
                    exit 1
                  fi
                  ;;
              esac

              mkdir -p "$target"

              if [ -L "$source_dir" ]; then
                linked_target=$(readlink "$source_dir")
                if [ "$linked_target" = "$target" ]; then
                  echo "patrol-migrate-data: $source_dir already points to $target"
                  exit 0
                fi
                echo "patrol-migrate-data: $source_dir is a symlink to $linked_target, not $target" >&2
                exit 1
              fi

              if [ ! -d "$source_dir" ]; then
                mkdir -p "$(dirname "$source_dir")"
                ln -s "$target" "$source_dir"
                echo "patrol-migrate-data: no old data directory existed; linked $source_dir -> $target"
                exit 0
              fi

              source_real=$(realpath "$source_dir")
              target_real=$(realpath "$target")
              if [ "$source_real" = "$target_real" ]; then
                echo "patrol-migrate-data: source and target are already the same directory"
                exit 0
              fi

              rsync -a "$source_dir"/ "$target"/
              mv "$source_dir" "$source_dir.before-volume-migration"
              ln -s "$target" "$source_dir"
              echo "patrol-migrate-data: copied $source_dir to $target and linked $source_dir -> $target"
            '';
          };
          patrol-migrate-recordings = pkgs.writeShellApplication {
            name = "patrol-migrate-recordings";
            runtimeInputs = [
              pkgs.coreutils
              pkgs.rsync
            ];
            text = ''
              set -euo pipefail
              ${loadLocalEnv}

              target="''${PATROL_RECORDINGS_DIR:-''${PATROL_DATA_DIR:-$PWD/.patrol}/recordings}"
              source_dir="''${PATROL_OLD_RECORDINGS_DIR:-''${PATROL_DATA_DIR:-$PWD/.patrol}/recordings}"

              case "$target" in
                /Volumes/*)
                  volume=/Volumes/$(printf '%s\n' "''${target#/Volumes/}" | cut -d / -f 1)
                  if [ ! -d "$volume" ]; then
                    echo "patrol-migrate-recordings: $volume is not mounted" >&2
                    exit 1
                  fi
                  ;;
              esac

              mkdir -p "$target"

              if [ -L "$source_dir" ]; then
                echo "patrol-migrate-recordings: $source_dir is already a symlink"
                exit 0
              fi

              if [ ! -d "$source_dir" ]; then
                mkdir -p "$(dirname "$source_dir")"
                ln -s "$target" "$source_dir"
                echo "patrol-migrate-recordings: no old recordings directory existed; linked $source_dir -> $target"
                exit 0
              fi

              source_real=$(realpath "$source_dir")
              target_real=$(realpath "$target")
              if [ "$source_real" = "$target_real" ]; then
                echo "patrol-migrate-recordings: source and target are already the same directory"
                exit 0
              fi

              rsync -a --remove-source-files "$source_dir"/ "$target"/
              find "$source_dir" -depth -type d -empty -delete
              rmdir "$source_dir" 2>/dev/null || true
              if [ ! -e "$source_dir" ]; then
                ln -s "$target" "$source_dir"
              fi

              echo "patrol-migrate-recordings: moved recordings to $target"
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
              patrol-migrate-data
              patrol-migrate-recordings
              patrol-person-recognizer
              patrol-recorder
              patrol-web-start
              patrol-watchdog
              patrol-watchdog-cron-install
            ];
            shellHook = ''
              if [ -f .env.local ]; then
                set -a
                . ./.env.local
                set +a
              fi
            '';
          };
        });
    };
}
