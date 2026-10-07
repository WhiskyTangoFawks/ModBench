using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>The FormKeys and EditorIDs a document's bytes carry, from one token pass.</summary>
internal static class DocumentTokens
{
    // The codec writes a link as a bare string and a child as an object with a FormKey of its
    // own, so the slot a key sits under tells the two apart. Malformed text yields what it read.
    internal static List<(string FormKey, bool AtRoot, bool InAnEmbedSlot)> FormKeysIn(byte[] bytes, GameRelease release)
    {
        var embeddedSlotNames = ContainerSlots.For(release).EmbeddedSlotNames;
        var found = new List<(string, bool, bool)>();
        var reader = new Utf8JsonReader(bytes);

        // The member that opened the container at each depth; null where an array element or the
        // document's own root opened it.
        var openedBy = new List<string?>();
        string? pendingMember = null;
        var atFormKey = false;
        var keyDepth = 0;
        try
        {
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName:
                        atFormKey = reader.ValueTextEquals(FormKeyPropertyName);
                        keyDepth = reader.CurrentDepth;
                        pendingMember = reader.GetString();
                        continue;
                    case JsonTokenType.StartObject or JsonTokenType.StartArray:
                        OpenedAt(openedBy, reader.CurrentDepth, pendingMember);
                        break;
                    case JsonTokenType.String when atFormKey:
                        var formKey = reader.GetString()
                            ?? throw new InvalidOperationException("Expected a JSON string value to read a non-null string.");
                        found.Add((formKey, keyDepth == 1, UnderAnEmbedSlot(openedBy, keyDepth, embeddedSlotNames)));
                        break;
                }
                atFormKey = false;
                pendingMember = null;
            }
        }
        catch (JsonException)
        {
            // Caught mid-save, or hand-edited into something that is not a document.
        }
        return found;
    }

    private static void OpenedAt(List<string?> openedBy, int depth, string? member)
    {
        while (openedBy.Count <= depth) openedBy.Add(null);
        openedBy[depth] = member;
    }

    // A child record's own FormKey sits inside the slot its container embeds it in, at any depth: a
    // worldspace embeds its TopCell, which embeds its placed references.
    private static bool UnderAnEmbedSlot(List<string?> openedBy, int keyDepth, IReadOnlySet<string> embeddedSlotNames)
    {
        for (var depth = 0; depth < keyDepth && depth < openedBy.Count; depth++)
        {
            if (openedBy[depth] is { } member && embeddedSlotNames.Contains(member)) return true;
        }
        return false;
    }

    private static ReadOnlySpan<byte> FormKeyPropertyName => "FormKey"u8;

    // Every EditorID member's value the document's bytes carry, at its own root or an embedded
    // child's, null for one that is no string: RecordMembers.EditorId is the one property name every
    // record's document uses for it.
    internal static List<string?> EditorIdsIn(byte[] bytes)
    {
        var found = new List<string?>();
        var reader = new Utf8JsonReader(bytes);
        var atEditorId = false;
        try
        {
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName:
                        atEditorId = reader.ValueTextEquals(EditorIdPropertyName);
                        continue;
                    case JsonTokenType.String when atEditorId:
                        found.Add(reader.GetString());
                        break;
                    case not JsonTokenType.Null when atEditorId:
                        found.Add(null);
                        reader.Skip();
                        break;
                }
                atEditorId = false;
            }
        }
        catch (JsonException)
        {
            // Caught mid-save, or hand-edited into something that is not a document.
        }
        return found;
    }

    private static readonly byte[] EditorIdPropertyName = Encoding.UTF8.GetBytes(RecordMembers.EditorId);

    internal static HashSet<string> FormKeysOf(IEnumerable<SourceDocument> documents, GameRelease release)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in documents)
        {
            keys.Add(document.FormKey);

            // A child inlined in this document is a record of its own with a FormKey of its own, so its
            // ID is as taken as any other.
            foreach (var (formKey, _, inAnEmbedSlot) in FormKeysIn(Encoding.UTF8.GetBytes(document.Body), release))
            {
                if (inAnEmbedSlot) keys.Add(formKey);
            }
        }
        return keys;
    }

    internal static HashSet<string> EditorIdsOf(IEnumerable<SourceDocument> documents)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in documents)
        {
            foreach (var editorId in EditorIdsIn(Encoding.UTF8.GetBytes(document.Body)))
                ids.Add(editorId ?? throw new InvalidOperationException($"{document.FormKey}'s document reached EditorIdsOf unread."));
        }
        return ids;
    }
}
