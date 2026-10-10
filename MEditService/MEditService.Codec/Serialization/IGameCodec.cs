using System.IO.Abstractions;
using System.Reflection;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.Codec.Serialization;

/// <summary>One game's part of the codec: Mutagen's serialization generator emits colliding code
/// when two games are in one compilation, so each game's project compiles the same source
/// against that game's types.</summary>
public interface IGameCodec
{
    /// <summary>The assembly that holds the game's generated &lt;Type&gt;_Serialization classes.</summary>
    Assembly GeneratedSerializers { get; }

    /// <summary>Under FilePerRecord the root document's stream also comes from streamCreator, so a
    /// caller can capture the mod header without writing a tree. workDropoff is sequential: the
    /// parallel list helpers have a real upstream race.</summary>
    Task SerializeWholeMod(
        IModGetter plugin, string folder, IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null);

    /// <summary>An in-memory read needs both fileSystem and streamCreator: the reader checks
    /// File.Exists before consulting the stream creator.</summary>
    Task<IMod> DeserializeWholeMod(
        string folder, IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null);

    /// <summary>The Next Object ID the game's serializer omits from a header document.</summary>
    uint NextObjectIdDefault { get; }

    /// <summary>The schema rows that make a member govern which of its siblings are in use, empty for a game with none.</summary>
    IReadOnlyDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> SiblingsInUse { get; }

    /// <summary>A copy of <paramref name="record"/> without the encoding a rewrite is entitled to
    /// change: group-header-derived fields zeroed, and a worldspace's block levels in one canonical
    /// order (ADR-0006).</summary>
    IMajorRecordGetter NormalizeEncoding(IMajorRecordGetter record);

    /// <summary>A mod holding <paramref name="plugin"/>'s header and no record, which the whole-mod
    /// door writes as the header document alone.</summary>
    IModGetter HeaderOnly(IModGetter plugin);
}
