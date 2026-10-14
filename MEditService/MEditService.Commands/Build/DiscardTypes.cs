using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to discard, with the installation files the mod manager records it as installed from.</summary>
public sealed record ModToDiscard(string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles);

/// <summary>The instance's facts beyond its mods: the game files the mods' files override, and where a delta is
/// looked for. DownloadedFiles are those searched for a delta beside each mod's installation files.</summary>
public sealed record InstanceToDiscard(
    IReadOnlyList<OverriddenGameFile> GameFiles, string DataFolder, string BuildFolder, string? DownloadsFolder,
    IReadOnlyList<InstallationFile> DownloadedFiles);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DiscardRefusal
{
    None,

    NoManifest,

    ManifestUnreadable,

    /// <summary>A file its manifest names has no provider, or one whose installation file or game file is missing or
    /// has other bytes, or whose delta has other bytes.</summary>
    Lacking,

    /// <summary>Each lack is a game file the request did not name, or a delta no place it searched holds.</summary>
    NotFound,

    /// <summary>A file the mod is discarded from could not be read: one of its own, an installation file or a game
    /// file.</summary>
    Unreadable,

    /// <summary>A write failed part way, so some files came back and some did not.</summary>
    NotFinished,
}

/// <summary>Why a mod was skipped. A NotFound mod names the game files and the deltas it lacks, by the paths and names a
/// request can bring them back with.</summary>
public sealed record DiscardSkip(DiscardRefusal Kind, IReadOnlyList<string> GameFilesNotFound, IReadOnlyList<string> DeltasNotFound);

/// <summary>A mod whose folder is as its manifest says, and the files written to make it so.</summary>
public sealed record DiscardedMod(IReadOnlyList<string> Written);
