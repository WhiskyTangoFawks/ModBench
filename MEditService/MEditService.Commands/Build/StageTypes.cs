using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to stage, with its installation files in the mod manager's order and the paths of its files
/// the repository commits itself, which the manifest does not name.</summary>
public sealed record ModToStage(
    string Name, string Folder, IReadOnlyList<InstallationFileToStage> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>An installation file by its path in the downloads folder, where the mod manager says it comes from,
/// and its size, hash and entries as the Instance adapter knows them (ADR-0024).</summary>
public sealed record InstallationFileToStage(string Path, string? Source, long Size, string Hash, IReadOnlyList<HashedEntry> Entries);

/// <summary>An entry of an installation file by its forward-slash path inside it.</summary>
public sealed record HashedEntry(string Path, string Hash);

/// <summary>A game file a mod file overrides, by its forward-slash path under the game's data folder, as the
/// Instance adapter knows it (ADR-0024).</summary>
public sealed record GameFileToStage(string Path, long Size, string Hash);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum StageRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    ModFolderMissing,

    /// <summary>A file of the mod could not be read.</summary>
    ModFilesUnreadable,

    ManifestNotWritten,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides.</summary>
public sealed record StagedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider);
