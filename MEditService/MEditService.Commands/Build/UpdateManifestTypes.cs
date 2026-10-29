using System.Text.Json.Serialization;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation file, version, metadata files, which no line names, source
/// folder if a source mod, and the game files it may take from, none when no game folder exists.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, InstallationFile? InstallationFile, IReadOnlyList<string> MetadataFiles, string? SourceFolder,
    string? Version, GameFolder? GameFolder = null);

/// <summary>A game file by its forward-slash path in the game folder, such as <c>Data/Fallout4.esm</c>, with its hash as the
/// Instance adapter knows it (ADR-0013), and the path of the folder's file it may be, when not its own.</summary>
public sealed record GameFile(string Path, string Hash, string? PathInFolder = null);

/// <summary>Another game folder holding the same game, such as the Steam install, at <paramref name="Root"/>, with the game files a
/// mod's files may be, and the store depots it records as installed.</summary>
public sealed record GameFolderPlace(string Root, IReadOnlyList<GameFile> Files, IReadOnlyList<GameDepot>? Depots = null);

/// <summary>The game folder as the Instance adapter hands it. Elsewhere: the game's other places, tried in order when this one
/// lacks a mod's pinned bytes. Depots: those it records, when it is the store's install.</summary>
public sealed record GameFolder(
    string Name, string Root, IReadOnlyList<GameFile> Files, IReadOnlyList<GameFolderPlace>? Elsewhere = null, IReadOnlyList<GameDepot>? Depots = null)
{
    internal IEnumerable<GameFolder> Places() =>
        [this with { Elsewhere = null }, .. (Elsewhere ?? []).Select(place => new GameFolder(Name, place.Root, place.Files, Depots: place.Depots))];
}

/// <summary>The instance's facts beyond its mods: the stat cache's folder and every downloaded file.</summary>
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
