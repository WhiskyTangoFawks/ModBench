using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to decompile and commit, by name, with the source folder its repository goes in, the mod manager's own files in
/// its folder, which no build makes, its installation file and its version.</summary>
public sealed record ModToDecompileAndCommit(
    string Name, string SourceFolder, IReadOnlyList<string> MetadataFiles, InstallationFile? InstallationFile = null, string? Version = null);

/// <summary>Why decompile and commit refused (ADR-0019): each value is a different way out, and the
/// endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DecompileAndCommitRefusal
{
    None,

    /// <summary>The load order holds no plugin the mod provides.</summary>
    ModProvidesNoPlugin,

    /// <summary>The mod's source folder already holds a repository.</summary>
    AlreadyInitialized,

    /// <summary>ADR-0006's gate refused it, or the plugin cannot be read or deep-parsed
    /// at all. A data problem in the plugin, not a state conflict.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>A file of the mod folder could not be read, so its assets are not known.</summary>
    ModFilesUnreadable,

    /// <summary>The plugins passed their gate, and the file system or git refused the source folder's files or its one commit,
    /// or the removal of the manifest its mod folder held.</summary>
    CommitFailed,

    /// <summary>The mod's refused plugins differ in reason; the message names each plugin and why.</summary>
    PluginsRefused,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}
