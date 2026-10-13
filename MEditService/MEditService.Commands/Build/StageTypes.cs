using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to stage, with its installation files in the mod manager's order and the paths of its files
/// the repository commits itself, which the manifest does not name.</summary>
public sealed record ModToStage(
    string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>A game file a mod file overrides, by its forward-slash path under the game's data folder, as the
/// Instance adapter knows it (ADR-0013).</summary>
public sealed record GameFileToStage(string Path, long Size, string Hash);

/// <summary>The instance's facts beyond its mods. DeltaShare is the share of its file a delta may reach before
/// the file counts as no provider.</summary>
public sealed record InstanceToStage(IReadOnlyList<GameFileToStage> GameFiles, string DataFolder, string BuildFolder, double DeltaShare);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum StageRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    ModFolderMissing,

    /// <summary>A file the mod is staged from could not be read: one of its own, an installation file or a game
    /// file.</summary>
    ModFilesUnreadable,

    /// <summary>The mod's manifest, or a delta it needs, could not be written.</summary>
    NotWritten,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides.</summary>
public sealed record StagedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider);
