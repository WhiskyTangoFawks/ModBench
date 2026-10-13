using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Commands.Build;

/// <summary>A mod to init, by name, with its installation files and the mod manager's own files in its folder,
/// which no build makes.</summary>
public sealed record ModToInit(string Name, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> ModManagerFiles);

/// <summary>Why init refused (ADR-0019): each value is a different way out, and the
/// endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum InitRefusal
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

    /// <summary>The plugins passed their gate, and the file system or git refused the source folder's files or its one commit.</summary>
    CommitFailed,

    /// <summary>The mod's refused plugins differ in reason; the message names each plugin and why.</summary>
    PluginsRefused,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}

/// <summary>A mod of the selection that landed whole: every plugin whose source its commit holds. A mod with any
/// plugin refused is refused instead, and writes nothing.</summary>
public sealed record InitializedMod(IReadOnlyList<PluginAddress> Plugins);
