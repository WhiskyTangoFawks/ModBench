using System.Text.Json.Serialization;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to restore, with what the request found of what its manifest names, why it could not
/// read its game files, by game path, or its installation file, and a source mod's source folder.</summary>
public sealed record ModToRestore(
    string Name, string Folder, InstallationFile? InstallationFile, IReadOnlyList<string> MetadataFiles, Submodule? Submodule,
    IReadOnlyDictionary<string, string>? UnreadableGameFiles, string? UnreadableInstallationFile, string? SourceFolder);

/// <summary>The instance's facts beyond its mods: the stat cache's folder, the game folder with the game files the request
/// found for the manifests, and what a build needs, as <see cref="InstanceToBuild"/>.</summary>
public sealed record InstanceToRestore(string StatCache, string ExclusionMark, ArchiveVariants? Archives, GameFolder? GameFolder);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RestoreRefusal
{
    None,

    NoManifest,

    ManifestUnreadable,

    /// <summary>A file its package does not hold, or an installation file that has other bytes.</summary>
    Lacking,

    /// <summary>Its package has no host, so no clone can fetch it (ADR-0022).</summary>
    NoHost,

    /// <summary>A lack is an installation file, a game file or a submodule the request did not hand.</summary>
    NotFound,

    /// <summary>A file the mod is restored from could not be read: one of its own or its installation file.</summary>
    Unreadable,

    /// <summary>A write failed part way, so some files came back and some did not, or its build left a plugin or an
    /// archive as it was.</summary>
    NotFinished,

    /// <summary>Its submodule is absent and could not be cloned, or its folder holds no repository that reads.</summary>
    SourceUnavailable,

    /// <summary>Its submodule is at another commit than the instance repository pins, and Modbench never moves a repository.</summary>
    SourceAtAnotherCommit,

    /// <summary>Its build refused it before writing.</summary>
    NotBuilt,

    /// <summary>Its manifest holds a step, which runs a VS Code task that restore cannot run.</summary>
    StepNotRun,
}

/// <summary>Why a mod was skipped. A NotFound mod names the installation file, the game files and the submodule it lacks, as a
/// request hands them; a NotBuilt mod, its build's refusal (ADR-0019).</summary>
internal sealed record RestoreSkip(RestoreRefusal Kind, BuildRefusal Build = BuildRefusal.None)
{
    public ManifestPackage.InstallationFile? InstallationFileNotFound { get; init; }

    public string? SubmoduleNotFound { get; init; }

    public IReadOnlyList<string> GameFilesNotFound { get; init; } = [];
}
