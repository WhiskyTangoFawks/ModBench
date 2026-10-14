using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to restore from its manifest, with the installation files the mod manager records it as installed from.</summary>
public sealed record ModToRestore(string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles);

/// <summary>The instance's facts beyond its mods: the game files the mods' files override, under the game's data folder,
/// and the folder of the stat cache.</summary>
public sealed record InstanceToRestore(IReadOnlyList<OverriddenGameFile> GameFiles, string DataFolder, string StatCache);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RestoreRefusal
{
    None,

    NoManifest,

    ManifestUnreadable,

    /// <summary>A file its manifest names has no provider, or one whose installation file or game file is missing or
    /// has other bytes.</summary>
    Lacking,

    /// <summary>Each lack is a game file the request did not name.</summary>
    NotFound,

    /// <summary>A file the mod is restored from could not be read: one of its own, an installation file or a game
    /// file.</summary>
    Unreadable,

    /// <summary>A write failed part way, so some files came back and some did not.</summary>
    NotFinished,
}

/// <summary>Why a mod was skipped. A NotFound mod names the game files it lacks, by the paths a request can bring them
/// back with.</summary>
public sealed record RestoreSkip(RestoreRefusal Kind, IReadOnlyList<string> GameFilesNotFound);

/// <summary>A mod whose folder is as its manifest says, the files written to make it so, and why the stat cache could not keep
/// what the restore read, or null.</summary>
public sealed record RestoredMod(IReadOnlyList<string> Written, string? StatCacheNotWritten);
