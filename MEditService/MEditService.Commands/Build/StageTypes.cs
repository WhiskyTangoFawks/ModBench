using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to stage, with its installation files in the mod manager's order and the paths of its files
/// the repository commits itself, which the manifest does not name.</summary>
public sealed record ModToStage(
    string Name, string Folder, IReadOnlyList<InstallationFileToStage> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>An installation file by its path in the downloads folder, and where the mod manager says it comes from.</summary>
public sealed record InstallationFileToStage(string Path, string? Source);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum StageRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    /// <summary>An installation file is there and cannot be read as an archive.</summary>
    InstallationFileUnreadable,

    ModFolderMissing,

    /// <summary>A file of the mod or of the game's data folder could not be read.</summary>
    ModFilesUnreadable,

    ManifestNotWritten,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides.</summary>
public sealed record StagedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider);
