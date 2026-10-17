using System.Text.Json.Serialization;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to restore from its manifest, with the installation file its manifest names if the request found it in the
/// downloads folder, its metadata files, and the folder its source is in or is cloned into.</summary>
public sealed record ModToRestore(
    string Name, string Folder, InstallationFile? InstallationFile, IReadOnlyList<string> MetadataFiles, string? SourceFolder);

/// <summary>The instance's facts beyond its mods: the stat cache's folder, the game folder with the game files the request
/// found for the manifests, and what a build needs, as <see cref="InstanceToBuild"/>.</summary>
public sealed record InstanceToRestore(string StatCache, string ExcludedSuffix, ArchiveVariants? Archives, GameFolder? GameFolder = null);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RestoreRefusal
{
    None,

    NoManifest,

    ManifestUnreadable,

    /// <summary>A file its package does not hold, or an installation file that has other bytes.</summary>
    Lacking,

    /// <summary>A lack is an installation file or a game file the request did not hand.</summary>
    NotFound,

    /// <summary>A file the mod is restored from could not be read: one of its own or its installation file.</summary>
    Unreadable,

    /// <summary>A write failed part way, so some files came back and some did not, or its build left a plugin or an
    /// archive as it was.</summary>
    NotFinished,

    /// <summary>Its source is absent and could not be cloned, or its folder holds no repository that reads.</summary>
    SourceUnavailable,

    /// <summary>Its source is at another commit than its manifest names, and Modbench never moves a repository.</summary>
    SourceAtAnotherCommit,

    /// <summary>Its build refused it before writing.</summary>
    NotBuilt,
}

/// <summary>Why a mod was skipped. A NotFound mod names the installation file and the game files it lacks, as a request hands
/// them; a NotBuilt mod, its build's refusal (ADR-0019).</summary>
public sealed record RestoreSkip(RestoreRefusal Kind, BuildRefusal Build = BuildRefusal.None)
{
    public string? InstallationFileNotFound { get; init; }

    public IReadOnlyList<string> GameFilesNotFound { get; init; } = [];
}

/// <summary>A mod whose files are as its manifest says: the files written, each file no line names, why the stat cache did
/// not keep the read, the metadata its manifest says, and Uncommitted as <see cref="BuiltMod"/>'s.</summary>
public sealed record RestoredMod(
    IReadOnlyList<string> Written, IReadOnlyList<string> NamedByNoLine, string? StatCacheNotWritten, ModMetadata Metadata, bool Uncommitted = false);
