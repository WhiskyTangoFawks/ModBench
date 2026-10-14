using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation files in the mod manager's order and the paths of its files
/// the repository commits itself, which the manifest does not name.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>A game file a mod file overrides, by its forward-slash path under the game's data folder, as the
/// Instance adapter knows it (ADR-0013).</summary>
public sealed record OverriddenGameFile(string Path, long Size, string Hash);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdateManifestRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    ModFolderMissing,

    /// <summary>A file of the mod could not be read.</summary>
    ModFilesUnreadable,

    /// <summary>The mod's manifest could not be written.</summary>
    NotWritten,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides.</summary>
public sealed record UpdatedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider);
