using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to version in git, by name and folder, and the source folder made for it, which names the repository that
/// holds it. Without <paramref name="Commit"/> the repository holds its files as staged changes.</summary>
public sealed record ModToVersionInGit(string Name, string ModFolder, SourceFolderContents SourceFolder, bool Commit);

/// <summary>Why version in git refused (ADR-0019): each value is a different way out, and the
/// endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum VersionInGitRefusal
{
    None,

    /// <summary>The mod's source folder is already a source mod's; its plugins go into the working tree by decompile.</summary>
    AlreadyInitialized,

    /// <summary>The mod's source folder holds a repository with no main branch that Modbench did not make.</summary>
    AnotherRepository,

    /// <summary>A plugin is malformed in a way a repair answers, and the gate refused it for that; the way out is decompile
    /// and repair.</summary>
    MalformedRepairable,

    /// <summary>ADR-0006's gate refused it, or the plugin cannot be read or deep-parsed
    /// at all. A data problem in the plugin, not a state conflict.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>The plugins passed their gate, and the file system or git refused the source folder's files or its one commit.</summary>
    CommitFailed,

    /// <summary>The mod's refused plugins differ in reason; the message names each plugin and why.</summary>
    PluginsRefused,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}
