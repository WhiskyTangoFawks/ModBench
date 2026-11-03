using System.Text.Json.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to version in git, by name and folder, the source folder made for it, and the repository that holds
/// it. Without <paramref name="Commit"/> the repository holds its files as staged changes.</summary>
public sealed record ModToVersionInGit(string Name, string ModFolder, SourceFolderContents Repository, SourceModIn In, bool Commit);

/// <summary>Why version in git refused (ADR-0019): each value is a different way out, and the
/// endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum VersionInGitRefusal
{
    None,

    /// <summary>The mod's source folder is already a source mod's, or holds a repository.</summary>
    AlreadyInitialized,

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
