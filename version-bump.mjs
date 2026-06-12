import { readFileSync, writeFileSync } from "fs";

// Run via `npm version <patch|minor|major>`; npm sets npm_package_version to the
// new version before this script runs. We mirror it into manifest.json and add a
// versions.json entry mapping the new plugin version to its minAppVersion.
const targetVersion = process.env.npm_package_version;

// Read minAppVersion from manifest.json and bump version to target version.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// Update versions.json with target version and minAppVersion from manifest.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
