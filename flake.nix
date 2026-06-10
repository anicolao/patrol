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
              config_path="$(node scripts/write-go2rtc-config.mjs)"
              exec go2rtc -c "$config_path"
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
              patrol-go2rtc-config
              patrol-go2rtc-observe
              patrol-go2rtc-start
            ];
          };
        });
    };
}
