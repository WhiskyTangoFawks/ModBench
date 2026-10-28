using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation file, its version, its metadata files, which no line
/// names, and a source mod's source folder, whose repository holds the manifest its build writes.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, InstallationFile? InstallationFile, IReadOnlyList<string> MetadataFiles, string? SourceFolder,
    string? Version);

/// <summary>A game file by its forward-slash path under the game's Data folder as the game folder names it, with its hash as the
/// Instance adapter knows it (ADR-0013).</summary>
public sealed record GameFile(string Path, string Hash);

/// <summary>Another Data folder holding the same game, such as the Steam install, with the game files at the paths of the mods' files.</summary>
public sealed record GameFolderPlace(string DataFolder, IReadOnlyList<GameFile> Files);

/// <summary>The game folder as the Instance adapter hands it. Elsewhere: the game's other places, tried in order
/// when this one lacks a mod's pinned bytes.</summary>
public sealed record GameFolder(string Name, string DataFolder, IReadOnlyList<GameFile> Files, IReadOnlyList<GameFolderPlace>? Elsewhere = null)
{
    internal IEnumerable<GameFolder> Places() => [this with { Elsewhere = null }, .. (Elsewhere ?? []).Select(place => new GameFolder(Name, place.DataFolder, place.Files))];
}

/// <summary>The instance's facts beyond its mods: the folder of the stat cache, the game folder, none when it was not found,
/// and the downloaded files the hash index holds, which a file its mod's installation file lacks is looked for in.</summary>
public sealed record InstanceToUpdate(string StatCache, GameFolder? GameFolder, IReadOnlyList<InstallationFile>? DownloadedFiles = null);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdateManifestRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    ModFolderMissing,

    /// <summary>A mod whose manifest names the game folder, when the request found none.</summary>
    GameFolderNotFound,

    /// <summary>A file of the mod could not be read.</summary>
    ModFilesUnreadable,

    /// <summary>The mod's manifest cannot be read, so what it holds that no folder shows, such as its steps, cannot be kept.</summary>
    ManifestUnreadable,

    /// <summary>The mod's manifest could not be written.</summary>
    NotWritten,

    /// <summary>A source mod whose folder differs from what its build wrote, or that its build wrote no manifest for
    /// (modlist-repository.md, Update manifest, story 5).</summary>
    LeftToItsBuild,
}
