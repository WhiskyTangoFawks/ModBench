using System.Text;
using System.Text.Json;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>Where a FormKey sits in a document: the record's own at the root, an embedded child's in
/// the slot its container embeds it in, or any other FormKey member.</summary>
public enum FormKeyPosition
{
    Root,
    Embedded,
    Other,
}

/// <summary>A FormKey a document's bytes carry, and where.</summary>
public readonly record struct DocumentFormKey(string FormKey, FormKeyPosition Position);

/// <summary>What a document's text carries and declares: the FormKeys and EditorIDs its bytes hold, its
/// root's strings, whether it is a document at all, and whether it may spell a given FormKey.</summary>
public static class DocumentTokens
{
    // The codec writes a link as a bare string and a child as an object with a FormKey of its
    // own, so the slot a key sits under tells the two apart. Malformed text yields what it read.
    public static List<DocumentFormKey> FormKeysIn(byte[] bytes, GameRelease release)
    {
        var embeddedSlotNames = RecordTypes.For(release).EmbeddedSlotNames;
        var found = new List<DocumentFormKey>();
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
                        found.Add(new DocumentFormKey(formKey, PositionOf(openedBy, keyDepth, embeddedSlotNames)));
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

    private static FormKeyPosition PositionOf(List<string?> openedBy, int keyDepth, IReadOnlySet<string> embeddedSlotNames)
    {
        if (keyDepth == 1) return FormKeyPosition.Root;
        return UnderAnEmbedSlot(openedBy, keyDepth, embeddedSlotNames) ? FormKeyPosition.Embedded : FormKeyPosition.Other;
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

    private static readonly byte[] FormKeyPropertyName = Encoding.UTF8.GetBytes(RecordMembers.FormKey);

    // Every EditorID member's value the document's bytes carry, at its own root or an embedded
    // child's, null for one that is no string: RecordMembers.EditorId is the one property name every
    // record's document uses for it.
    public static List<string?> EditorIdsIn(byte[] bytes)
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

    /// <summary>A member of the document's own root object, as a string. Malformed text declares
    /// nothing.</summary>
    public static string? RootStringIn(string text, string member)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty(member, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Why <paramref name="text"/> is no document, in the reader's words; null when its root is a
    /// JSON object, which a member can be read from.</summary>
    public static string? WhyNotADocument(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object ? null : "its root is not a JSON object.";
        }
        catch (JsonException ex)
        {
            return ex.Message;
        }
    }

    /// <summary>False only when the bytes certainly do not spell <paramref name="formKey"/>: JSON spells
    /// it other than literally only through a \u escape, since no plugin file name holds a quote,
    /// backslash, slash or control character.</summary>
    public static bool MayCarry(byte[] document, string formKey) =>
        document.AsSpan().IndexOf(Encoding.UTF8.GetBytes(formKey)) >= 0 || document.AsSpan().IndexOf(@"\u"u8) >= 0;
}
