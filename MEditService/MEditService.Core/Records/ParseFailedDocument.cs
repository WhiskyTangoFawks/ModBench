using System.Text;
using System.Text.Json;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>The document stored for a record whose own document could not be produced: the members
/// the codec reads before any field, and nothing else. Every later read deserializes it.</summary>
internal static class ParseFailedDocument
{
    internal static byte[] For(IMajorRecordGetter record, string? editorId, GameRelease release)
    {
        var members = new List<string>();
        // ADR-0041's discriminator policy, from the same RecordTypeDispatch fact the codec's two
        // directions agree on: a path-ambiguous document leads with its concrete type, and without
        // it the reader has nothing to dispatch on.
        var dispatch = RecordTypeDispatch.For(release);
        if (dispatch.IsPathAmbiguous(record.GetType())
            && dispatch.ConcreteFor(record.GetType().Name) is { } concrete)
        {
            members.Add(Member("MutagenObjectType", concrete.Name));
        }
        members.Add(Member("FormKey", record.FormKey.ToString()));
        if (editorId != null) members.Add(Member("EditorID", editorId));

        // The codec's own shape: two-space indent, "\n" throughout, no trailing newline.
        return Encoding.UTF8.GetBytes($"{{\n{string.Join(",\n", members)}\n}}");
    }

    private static string Member(string name, string value) =>
        $"  {JsonSerializer.Serialize(name)}: {JsonSerializer.Serialize(value)}";
}
