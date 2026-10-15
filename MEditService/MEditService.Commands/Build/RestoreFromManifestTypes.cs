using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to restore from its manifest, with the installation files its manifest names that the request found in the
/// downloads folder, its files the repository commits, and the folder its source is in or is cloned into.</summary>
public sealed record ModToRestore(
    string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> CommittedFiles, string? SourceFolder);

/// <summary>The instance's facts beyond its mods: the game files the mods' files override, under the game's data folder,
/// the stat cache's folder, and what a build needs, as <see cref="InstanceToBuild"/>.</summary>
public sealed record InstanceToRestore(
    IReadOnlyList<OverriddenGameFile> GameFiles, string DataFolder, string StatCache, string ExcludedSuffix, ArchiveVariants? Archives);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RestoreRefusal
{
    None,

    NoManifest,

    ManifestUnreadable,

    /// <summary>A file its manifest names has no provider, or one whose installation file or game file is missing or
    /// has other bytes.</summary>
    Lacking,

    /// <summary>A lack is an installation file or a game file the request did not hand.</summary>
    NotFound,

    /// <summary>A file the mod is restored from could not be read: one of its own, an installation file or a game
    /// file.</summary>
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

/// <summary>Why a mod was skipped. A NotFound mod names the game files it lacks, by the paths a request can bring them
/// back with, and the installation files, by their names; a NotBuilt mod, its build's refusal (ADR-0019).</summary>
public sealed record RestoreSkip(
    RestoreRefusal Kind, IReadOnlyList<string> GameFilesNotFound, IReadOnlyList<string> InstallationFilesNotFound, BuildRefusal Build = BuildRefusal.None);

/// <summary>A mod whose files are as its manifest says: the files written, each file no line names, for the trash, why
/// the stat cache did not keep the read, and Uncommitted as <see cref="BuiltMod"/>'s.</summary>
public sealed record RestoredMod(IReadOnlyList<string> Written, IReadOnlyList<string> NamedByNoLine, string? StatCacheNotWritten, bool Uncommitted = false);
