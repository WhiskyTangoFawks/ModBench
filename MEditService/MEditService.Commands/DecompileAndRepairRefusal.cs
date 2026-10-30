using System.Text.Json.Serialization;

namespace MEditService.Commands;

/// <summary>Why decompile and repair, or its preview, refused a plugin (ADR-0019): each value is a different way out.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DecompileAndRepairRefusal
{
    None,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,

    /// <summary>git is not on PATH (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>No loaded plugin is the file name and origin the gesture named.</summary>
    PluginNotLoaded,

    /// <summary>The plugin comes from the game or from no mod, so no mod can hold its source; no gesture clears it.</summary>
    NotFromAMod,

    /// <summary>The plugin's bytes could not be read.</summary>
    Unreadable,

    /// <summary>No malformed record is diagnosed in the plugin; the way out is decompile.</summary>
    NotMalformed,

    /// <summary>The plugin's bytes are not the ones the preview read; the way out is a new preview.</summary>
    ChangedSincePreview,

    /// <summary>A diagnosis of the plugin that no repair answers.</summary>
    NoRepair,

    /// <summary>A repair that drops data, and the request did not force. Nothing was written.</summary>
    DropsData,

    /// <summary>The repaired plugin is not the original with its repairs, or cannot become source without losing meaning.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>The plugin source has working-tree changes the repair would replace, and the request did not force.</summary>
    WorkingTreeChanges,

    /// <summary>git could not report whether the plugin source has working-tree changes. Nothing was written.</summary>
    WorkingTreeStatusUnreadable,

    /// <summary>The plugin source holds twin folders and none is its tree; the way out is removing the extra by hand.</summary>
    AmbiguousSource,

    /// <summary>The mod has no repository and the request hands none to make.</summary>
    NoSourceFolder,

    /// <summary>The mod's source folder holds a repository Modbench did not make.</summary>
    AnotherRepository,

    /// <summary>The mod has no repository, and another of its plugins cannot become source to make one with.</summary>
    OtherPluginRefused,

    /// <summary>The repair passed its checks, and git or the file system refused the commits. Nothing was written.</summary>
    WriteFailed,

    /// <summary>The plugin adapter could not make the repair, for a reason no other value names. Nothing was written.</summary>
    RepairFailed,
}
