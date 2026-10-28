using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>Why build refused (ADR-0019): each value is a different way out.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BuildRefusal
{
    None,

    /// <summary>git is not on PATH (ADR-0007), a cause no mod of a selection escapes.</summary>
    GitUnavailable,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,

    /// <summary>The source folder holds no manifest that reads, or assets one mod folder cannot hold.</summary>
    SourceUnreadable,

    /// <summary>The manifest names an output folder that is not the mod's (mods.md, Build, story 4).</summary>
    OutputNotThisMod,

    /// <summary>An archive takes a file that is not an asset of the source.</summary>
    ArchiveFileNotAnAsset,

    /// <summary>This machine has no VS Code task for a tool its manifest's steps run (mods.md, Build, story 14).</summary>
    NoTaskForTool,

    /// <summary>A package its manifest names lacks what a file takes: an installation file is missing from the downloads folder,
    /// has other bytes, or holds no entry; the game folder lacks a file or holds it with other bytes (modlist-repository.md,
    /// Restore from manifest, story 4).</summary>
    PackageLacking,
}
