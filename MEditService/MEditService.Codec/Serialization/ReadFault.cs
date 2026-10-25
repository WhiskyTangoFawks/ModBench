using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Serialization;

/// <summary>Where in a document the reader fails. Mutagen throws with no position, but a member that fails
/// alone, in a document stripped to its identity and that member, is a member at fault.</summary>
internal static class ReadFault
{
    private const string NullFormKey = "Null";

    /// <summary>The reader's refusal of <paramref name="text"/>, naming every field it fails on; null where none
    /// can be found. <paramref name="identity"/> names the root members every stripped document keeps.</summary>
    internal static string? Describe(string text, Func<string, Exception?> thrownBy, IReadOnlySet<string> identity)
    {
        if (JsonNode.Parse(text) is not JsonObject root || thrownBy(Only(root, [], identity)) is not null) return null;

        var faults = FaultsIn(root, [], thrownBy, identity).ToList();
        return faults.Count > 0 ? string.Join("; ", faults.Select(fault => Say(fault.Path, fault.Thrown))) : null;
    }

    /// <summary>A member the reader takes without throwing but reads as a value of another meaning, whose misreading
    /// breaks the members after it: each member alone, against what the codec writes back of it.</summary>
    internal static string? MisreadMember(string text, Func<string, string> produce, IReadOnlySet<string> identity)
    {
        if (JsonNode.Parse(text) is not JsonObject root) return null;

        var misread = new List<string>();
        foreach (var key in root.Select(member => member.Key).Where(key => !IsIdentity(key, identity)))
        {
            var alone = Only(root, [key], identity);
            if (ProducedOrNull(produce, alone) is not { } producedText) continue;
            using var written = JsonDocument.Parse(alone);
            using var produced = JsonDocument.Parse(producedText);
            if (!produced.RootElement.TryGetProperty(key, out var counterpart)
                || DocumentMeaning.FirstDifference(written.RootElement.GetProperty(key), counterpart) is not null)
            {
                misread.Add($"{key} holds a value of the wrong type.");
            }
        }
        return misread.Count > 0 ? string.Join("; ", misread) : null;
    }

    private static string? ProducedOrNull(Func<string, string> produce, string source)
    {
        try
        {
            return produce(source);
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return null;
        }
    }

    internal static string Unlocated(Exception thrown) =>
        IsRewrapped(thrown) && thrown.InnerException is NullReferenceException inner ? inner.Message : thrown.Message;

    // The generated reader's own NotImplementedException and NullReferenceException arrive as a
    // "No record type matches" refusal, which is not what a mistyped or null value is.
    private static bool IsRewrapped(Exception thrown) =>
        thrown is NotSupportedException { InnerException: NotImplementedException or NullReferenceException };

    private static string Say(string[] path, Exception thrown) =>
        IsRewrapped(thrown) ? $"{Spell(path)} holds a value of the wrong type." : $"{Spell(path)}: {thrown.Message}";

    private static IEnumerable<(string[] Path, Exception Thrown)> FaultsIn(
        JsonObject root, string[] path, Func<string, Exception?> thrownBy, IReadOnlySet<string> identity)
    {
        foreach (var key in KeysOf(NodeAt(root, path)))
        {
            string[] memberPath = [.. path, key];
            if (thrownBy(Only(root, memberPath, identity)) is not { } thrown) continue;

            var inner = FaultsIn(root, memberPath, thrownBy, identity).ToList();
            if (inner.Count > 0)
            {
                foreach (var fault in inner) yield return fault;
            }
            else
            {
                yield return (memberPath, thrown);
            }
        }
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

    private static bool IsIdentity(string name, IReadOnlySet<string> identity) =>
        name == RecordMembers.FormKey || name == LoquiUnions.UnionTypeDiscriminator || identity.Contains(name);

    // The document stripped to its identity and the member at path. The identity is the type it names, the
    // members the caller names and a FormKey, which is the null one unless the member at path is the FormKey itself.
    private static string Only(JsonObject root, string[] path, IReadOnlySet<string> identity)
    {
        var copy = (JsonObject)root.DeepClone();
        var member = path.Length > 0 ? path[0] : null;
        foreach (var name in copy.Select(entry => entry.Key).ToArray())
        {
            if (name != member && !IsIdentity(name, identity)) _ = copy.Remove(name);
        }
        if (member != RecordMembers.FormKey && copy.ContainsKey(RecordMembers.FormKey)) copy[RecordMembers.FormKey] = NullFormKey;

        JsonNode? node = member is null ? null : copy[member];
        foreach (var key in path.Skip(1))
        {
            node = node switch
            {
                JsonObject owner => KeepOnly(owner, key),
                JsonArray list => KeepOnly(list, int.Parse(key, CultureInfo.InvariantCulture)),
                _ => null,
            };
        }
        return copy.ToJsonString();
    }

    private static JsonNode? KeepOnly(JsonObject owner, string key)
    {
        foreach (var name in owner.Select(entry => entry.Key).ToArray())
        {
            if (name != key) _ = owner.Remove(name);
        }
        return owner[key];
    }

    private static JsonNode? KeepOnly(JsonArray list, int index)
    {
        for (var at = list.Count - 1; at >= 0; at--)
        {
            if (at != index) list.RemoveAt(at);
        }
        return list[0];
    }

    private static string Spell(string[] path)
    {
        var spelled = new StringBuilder();
        foreach (var key in path)
        {
            if (int.TryParse(key, CultureInfo.InvariantCulture, out _)) _ = spelled.Append('[').Append(key).Append(']');
            else _ = spelled.Append(spelled.Length == 0 ? "" : ".").Append(key);
        }
        return spelled.ToString();
    }
}
