# Release

The developer releases. A release is a version commit on main, an annotated tag `vX.Y.Z`, and a GitHub pre-release that holds one `.vsix` per platform and `SHA256SUMS`. Modbench is alpha, so every release is a pre-release and a goal's close is the usual reason for one.

## Steps

1. Start on main with a clean tree. Every goal the release names has passed its acceptance.
2. Run the gates on Linux, then the Windows gates through `/windows-vm`. The Windows gates include a Package gate: the Windows `.vsix` installs and its bundled backend answers `/health`. Then run the tools: from `MEditService/`, `slot-run.sh dotnet test -m:1 --filter Kind=Tool`, and from `modbench/`, `slot-run.sh npm run tools`. A tool that fails has a finding. A sweep's becomes a fixture, as [tests.md](../../spec/architecture/tests.md) says.
3. Edit the `version` line of `modbench/package.json` and the two version lines at the top of `modbench/package-lock.json`. Do not run `npm version`: it reformats `package.json`. A minor bump is a goal. A patch bump is a fix to a release.
4. Make README.md's Status true for this release: what works today, and what is planned. Grep `docs/` for a command or a format a breaking change renamed.
5. Commit the two files and the docs as `Modbench X.Y.Z: the version, and a README that says what X.Y.Z does`.
6. Package on Linux, from `modbench/`: `slot-run.sh npm run package`. It builds both targets. A zip written on Windows has no execute bit, so the Linux `.vsix` never comes from Windows.
7. In `modbench/`, `sha256sum *.vsix > SHA256SUMS`. The `.vsix` files are gitignored.
8. Tag the version commit: `git tag -a vX.Y.Z -m "Modbench X.Y.Z (alpha)"`. Push main and the tag.
9. Publish: `gh release create vX.Y.Z --prerelease --title "Modbench X.Y.Z (alpha)" --notes-file <notes> modbench/*.vsix modbench/SHA256SUMS`.

Tagging, pushing and publishing are outward-facing: an agent does them only when the developer says so.

## Release notes

Use the previous release's notes as the template: `gh release view vX.Y.Z --json body -q .body`. Keep its order:

- An opening paragraph: what the release is, the supported games and platforms, and the alpha warning.
- Breaking changes, each with a "To upgrade" line. Find them by diffing the previous tag against main in `package.json` (commands, settings), the wire formats (manifest, build file, plugin source), the MCP tools and the HTTP endpoints. Nothing migrates, so say what the user does by hand.
- What's new, one paragraph a feature, by what the user can now do.
- Install, with the minimum VS Code version from `engines.vscode` and the tools the user needs.
