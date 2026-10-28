using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation file, version, metadata files, which no line names, source
/// folder if a source mod, and the game files it may take from, none when no game folder exists.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, InstallationFile? InstallationFile, IReadOnlyList<string> MetadataFiles, string? SourceFolder,
    string? Version, GameFolder? GameFolder = null);

/// <summary>A game file by its forward-slash path under the game's Data folder as the game folder names it, with its hash as the
/// Instance adapter knows it (ADR-0013).</summary>
public sealed record GameFile(string Path, string Hash);

/// <summary>Another Data folder holding the same game, such as the Steam install, with the game files a mod's files may be.</summary>
public sealed record GameFolderPlace(string DataFolder, IReadOnlyList<GameFile> Files);

/// <summary>The game folder as the Instance adapter hands it. Elsewhere: the game's other places, tried in order
/// when this one lacks a mod's pinned bytes.</summary>
public sealed record GameFolder(string Name, string DataFolder, IReadOnlyList<GameFile> Files, IReadOnlyList<GameFolderPlace>? Elsewhere = null)
{
    internal IEnumerable<GameFolder> Places() => [this with { Elsewhere = null }, .. (Elsewhere ?? []).Select(place => new GameFolder(Name, place.DataFolder, place.Files))];
}

/// <summary>The instance's facts beyond its mods: the stat cache's folder and the downloaded files already hashed.</summary>
public sealed record InstanceToUpdate(string StatCache, IReadOnlyList<InstallationFile> DownloadedFiles);

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
