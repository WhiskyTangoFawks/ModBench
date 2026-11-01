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

    /// <summary>The source folder cannot be read, lacks a path a copy names, or holds files one mod folder cannot hold.</summary>
    SourceUnreadable,

    /// <summary>An archive takes a loose file its mod's folder does not hold.</summary>
    ArchiveFileNotInFolder,

    /// <summary>A plugin a decompile names is not in the source folder, or does not decompile.</summary>
    NotDecompiled,
}
