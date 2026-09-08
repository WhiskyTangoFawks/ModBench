using System.Text.Json.Nodes;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>A record holding nothing but its identity, for the gestures that have to invent one: the
/// Create gesture's new record, and the Partial Form ancestor a copy mints around a child.</summary>
internal static class RecordMint
{
    /// <summary>The codec is the one constructor: a record begins as the document naming its identity,
    /// read back through the door every edit goes through. <paramref name="partialForm"/> sets the
    /// header bit a bare container ancestor carries.</summary>
    internal static IMajorRecord Bare(
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
        return codec.Deserialize(members.ToJsonString(), release, schema.TableName);
    }
}
