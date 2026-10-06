using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>A record holding nothing but its identity, for the gestures that have to invent one.</summary>
public static class RecordMint
{
    /// <summary>The codec is the one constructor: a record begins as the document naming its identity,
    /// read back through the door every edit goes through.</summary>
    internal static IMajorRecord Bare(
        RecordTextCodec codec, RecordTableSchema schema, GameRelease release, string formKey, string? editorId, bool interior = false)
    {
        var members = new JsonObject();
        // A path-ambiguous document leads with its concrete type.
        if (RecordTypeDispatch.For(release).IsPathAmbiguous(schema.TableName)
            && ReflectedTypes.GetSetterType(schema.RecordType) is { } concrete)
        {
            members[LoquiUnions.UnionTypeDiscriminator] = ReflectedTypes.DocumentTypeName(concrete);
        }
        members[nameof(IMajorRecordGetter.FormKey)] = formKey;
        if (editorId != null) members[nameof(IMajorRecordGetter.EditorID)] = editorId;
        if (interior) members[PlacedCell.FlagsMember] = new JsonArray(PlacedCell.InteriorFlag);
        return codec.Deserialize(members.ToJsonString(), release, schema.TableName);
    }

    /// <summary>The same record as a document, for a caller that writes text rather than a graph.</summary>
    public static string BareDocument(
        RecordTextCodec codec, RecordTableSchema schema, GameRelease release, string formKey, string? editorId, bool interior = false) =>
        codec.SerializeToText(Bare(codec, schema, release, formKey, editorId, interior), release);
}
