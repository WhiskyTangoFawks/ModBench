using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>The statics the copy, create and scan sides all reach into: every write here lands as a
/// working-tree change to the record's source JSON, and every refusal precedes it.</summary>
internal static class RecordEditService
{
    /// <summary>The codec is the one constructor: a record begins as the document naming its identity,
    /// read back through the door every edit goes through. <paramref name="partialForm"/> sets the
    /// header bit a bare container ancestor carries.</summary>
    internal static IMajorRecord BareRecord(
        RecordTextCodec codec, RecordTableSchema schema, GameRelease release, string formKey, string? editorId, bool partialForm)
    {
        var members = new JsonObject();
        // ADR-0041's discriminator policy: a path-ambiguous document leads with its concrete type.
        if (RecordTypeDispatch.For(release).IsPathAmbiguous(schema.TableName)
            && ReflectedTypes.GetSetterType(schema.RecordType) is { } concrete)
        {
            members[LoquiUnions.UnionTypeDiscriminator] = ReflectedTypes.DocumentTypeName(concrete);
        }
        members[nameof(IMajorRecordGetter.FormKey)] = formKey;
        if (editorId != null) members[nameof(IMajorRecordGetter.EditorID)] = editorId;
        if (partialForm) members[nameof(IMajorRecordGetter.MajorRecordFlagsRaw)] = PartialFormFlag.Bit;
        return codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(members.ToJsonString()), release, schema.TableName)
            .GetAwaiter().GetResult();
    }

    // A record with child slots: the copy gestures land it own-fields-only, and replace an existing
    // override in place rather than refusing.
    internal static bool IsContainerType(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType) is { } concrete
        && ContainerChildFields.EnumerateChildFieldsFor(concrete) != null;

    /// <summary>Whether this record type is the game's cell — the one type whose place in the world is
    /// its directory rather than a slot.</summary>
    internal static bool IsCellType(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name == "Cell";

    /// <summary>The document's own graph, read back through the codec by the type its text names —
    /// a path-ambiguous group's document names its own class, which is the codec's spelling, not the
    /// schema's table.</summary>
    internal static IMajorRecord ReadDocument(RecordTextCodec codec, SourceDocument document, GameRelease release) =>
        codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body), release, document.RecordType)
            .GetAwaiter().GetResult();

    /// <summary>Interior placement carries no gameplay meaning (PlacementWalker records null block/sub
    /// for every interior cell), so this reuses whichever block/sub-block directory the destination
    /// already has, minting <c>0/0</c> only the first time.</summary>
    internal static IReadOnlyList<string> EnsureInteriorCellBlockPath(
        string modFolder, string pluginName, GameRelease release)
    {
        var cellsFolder = RecordTypeDispatch.For(release).GroupFolderNameFor("cell")
            ?? throw new InvalidOperationException(
                "This game's schema has no Cell group folder — RefuseIfCopySourceHasNoContainerOfItsOwn should have refused this first.");
        var cellsDirectory = Path.Combine(modFolder, SourceRepository.RootFor(pluginName), cellsFolder);
        SourceRepository.InMintedDirectory(cellsDirectory, () => WriteMinimalGroupRecordDataIfMissing(cellsDirectory, groupType: null));

        var blockDirectory = FindOrMintGroupDirectory(cellsDirectory, "InteriorCellBlock");
        var subBlockDirectory = FindOrMintGroupDirectory(blockDirectory, "InteriorCellSubBlock");

        return [Path.GetFileName(blockDirectory), Path.GetFileName(subBlockDirectory)];
    }

    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory).FirstOrDefault();
        if (existing != null) return existing;

        var directory = Path.Combine(parentDirectory, "0");
        SourceRepository.InMintedDirectory(directory, () => WriteMinimalGroupRecordDataIfMissing(directory, groupType));
        return directory;
    }

    // Matches Track's own WriteIndented output; WriteMinimalGroupRecordDataIfMissing's byte-exact
    // contract depends on it.
    private static readonly JsonSerializerOptions GroupRecordDataOptions = new() { WriteIndented = true };

    // Not a record the codec has a schema for, so written directly. BlockNumber is omitted because
    // Track omits a BlockNumber of 0; the bytes are verified identical to Track's for both shapes,
    // which byte-compare tooling depends on.
    private static void WriteMinimalGroupRecordDataIfMissing(string directory, string? groupType)
    {
        var path = Path.Combine(directory, SourceRepository.GroupRecordDataFileName);
        if (File.Exists(path)) return;
        var bytes = groupType == null
            ? JsonSerializer.SerializeToUtf8Bytes(new { }, GroupRecordDataOptions)
            : JsonSerializer.SerializeToUtf8Bytes(new { GroupType = groupType }, GroupRecordDataOptions);
        File.WriteAllBytes(path, bytes);
    }

    /// <summary>Writes the record's file at its placement, minting the directories above it and
    /// removing them again if the write throws.</summary>
    internal static string WriteAt(string modFolder, SourcePlacement placement, Func<string, string> write)
    {
        var path = Path.Combine(modFolder, placement.RelativePath);
        return SourceRepository.InMintedDirectory(Path.GetDirectoryName(path)!, () => write(path));
    }

    /// <summary>Two serializations, one for the index and one for disk; <see cref="RecordTextCodec"/>
    /// producing identical bytes for both is what makes what the index is told and what lands the same text.</summary>
    internal static string SerializeAndWrite(RecordTextCodec codec, IMajorRecord record, string path, GameRelease release)
    {
        var bytes = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        codec.SerializeAsync(record, path, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }
}
