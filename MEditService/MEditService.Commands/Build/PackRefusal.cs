using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>Why an archive of a build was not packed (ADR-0019); it stays as it was.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ArchiveRefusal
{
    None,

    /// <summary>The game's per-release table names no variant Modbench writes.</summary>
    VariantNotWritten,

    /// <summary>A file the archive takes cannot go into it.</summary>
    FileNotPackable,

    /// <summary>A file it takes could not be read, or the archive could not be written.</summary>
    NotWritten,
}

internal sealed record PackRefusal(ArchiveRefusal Reason, string Message);
