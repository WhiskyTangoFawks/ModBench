using System.Globalization;
using System.Text.Json.Nodes;

namespace MEditService.Codec.Serialization;

/// <summary>Where in a document the reader fails. Mutagen throws with no position, but a document reads
/// once the member at fault is left out, since a field left out is the field at its default.</summary>
internal static class ReadFault
{
    /// <summary>The reader's refusal of <paramref name="text"/>, naming the field it fails on where one
    /// can be found; <paramref name="reads"/> says whether a document reads.</summary>
    internal static string Describe(Exception thrown, string text, Func<string, bool> reads)
    {
        if (JsonNode.Parse(text) is not JsonObject root || FieldIn(root, [], reads) is not { } field) return thrown.Message;

        var named = Spell(field);
        return IsRewrapped(thrown)
            ? $"{named} holds a value of the wrong type."
            : $"{named}: {thrown.Message}";
    }

    private const string NullFormKey = "Null";

    // The generated reader's own NotImplementedException and NullReferenceException arrive as a
    // "No record type matches" refusal, which is not what a mistyped or null value is.
    private static bool IsRewrapped(Exception thrown) =>
        thrown is NotSupportedException { InnerException: NotImplementedException or NullReferenceException };

    private static string[]? FieldIn(JsonObject root, string[] path, Func<string, bool> reads)
    {
        var owner = NodeAt(root, path);
        foreach (var key in KeysOf(owner))
        {
            string[] memberPath = [.. path, key];
            if (!reads(Without(root, memberPath))) continue;

            return NodeAt(root, memberPath) is null ? memberPath : FieldIn(root, memberPath, reads) ?? memberPath;
        }
        return null;
    }

    private static string[] KeysOf(JsonNode? node) => node switch
    {
        JsonObject owner => [.. owner.Select(member => member.Key)],
        JsonArray list => [.. Enumerable.Range(0, list.Count).Select(index => index.ToString(CultureInfo.InvariantCulture))],
        _ => [],
    };

    private static JsonNode? NodeAt(JsonNode root, string[] path)
    {
        var node = (JsonNode?)root;
        foreach (var key in path)
        {
            node = node switch
            {
                JsonObject owner => owner[key],
                JsonArray list => list[int.Parse(key, CultureInfo.InvariantCulture)],
                _ => null,
            };
        }
        return node;
    }

    private static string Without(JsonObject root, string[] path)
    {
        var copy = root.DeepClone();
        var key = path[^1];
        switch (NodeAt(copy, path[..^1]))
        {
            case JsonArray list:
                list.RemoveAt(int.Parse(key, CultureInfo.InvariantCulture));
                break;
            case JsonObject owner when key == RecordMembers.FormKey:
                owner[key] = NullFormKey;
                break;
            case JsonObject owner:
                _ = owner.Remove(key);
                break;
            default:
                break;
        }
        return copy.ToJsonString();
    }

    private static string Spell(string[] path)
    {
        var spelled = new System.Text.StringBuilder();
        foreach (var key in path)
        {
            if (int.TryParse(key, CultureInfo.InvariantCulture, out _)) _ = spelled.Append('[').Append(key).Append(']');
            else _ = spelled.Append(spelled.Length == 0 ? "" : ".").Append(key);
        }
        return spelled.ToString();
    }
}
