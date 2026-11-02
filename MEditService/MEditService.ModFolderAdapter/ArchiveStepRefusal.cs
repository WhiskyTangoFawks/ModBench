using System.Text.Json.Serialization;

namespace MEditService.ModFolderAdapter;

/// <summary>Why an archive of a build was not packed or unpacked (ADR-0019); it stays as it was.</summary>
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

    /// <summary>The archive is in a format Mutagen's reader cannot read.</summary>
    ArchiveUnreadable,

    /// <summary>A file an unpack takes is not an entry of the archive.</summary>
    FileNotInArchive,

    /// <summary>Two entries of the archive differ only in case, so a file an unpack takes names neither alone.</summary>
    EntriesAmbiguous,

    /// <summary>A texture an unpack takes is a cubemap, whose flag Mutagen's extraction drops.</summary>
    CubemapNotUnpackable,
}

public sealed record ArchiveStepRefusal(ArchiveRefusal Reason, string Message);
