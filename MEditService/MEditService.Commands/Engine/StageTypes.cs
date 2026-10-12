using System.Text.Json.Serialization;

namespace MEditService.Commands.Engine;

/// <summary>A mod to stage: its name, its folder and the installation files the mod manager records it as
/// installed from, in the order it records them.</summary>
public sealed record ModToStage(string Name, string Folder, IReadOnlyList<InstallationFileToStage> InstallationFiles);

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
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides.</summary>
public sealed record StagedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider);
