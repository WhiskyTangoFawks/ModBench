using System.Text.Json;

namespace MEditService.Codec.Serialization;

/// <summary>Whether two documents mean the same: JSON values equal, spacing and key order aside.</summary>
internal static class DocumentMeaning
{
    private const string Root = "the document";

    /// <summary>The path of the first member where <paramref name="written"/> and <paramref name="produced"/>
    /// differ, or null when they mean the same.</summary>
    internal static string? FirstDifference(JsonElement written, JsonElement produced) => Difference(written, produced, Root);

    private static string? Difference(JsonElement written, JsonElement produced, string path)
    {
        if (written.ValueKind != produced.ValueKind) return path;
        return written.ValueKind switch
        {
            JsonValueKind.Object => ObjectDifference(written, produced, path),
            JsonValueKind.Array => ArrayDifference(written, produced, path),
            JsonValueKind.String => written.GetString() == produced.GetString() ? null : path,
            JsonValueKind.Number => written.GetDouble().Equals(produced.GetDouble()) ? null : path,
            _ => null,
        };
    }

    private static string? ObjectDifference(JsonElement written, JsonElement produced, string path)
    {
        foreach (var member in written.EnumerateObject())
        {
            var memberPath = Member(path, member.Name);
            if (!produced.TryGetProperty(member.Name, out var counterpart)) return memberPath;
            if (Difference(member.Value, counterpart, memberPath) is { } found) return found;
        }
        return produced.EnumerateObject().Select(member => member.Name).FirstOrDefault(name => !written.TryGetProperty(name, out _)) is { } extra
            ? Member(path, extra)
            : null;
    }

    private static string? ArrayDifference(JsonElement written, JsonElement produced, string path)
    {
        var writtenItems = written.EnumerateArray().ToArray();
        var producedItems = produced.EnumerateArray().ToArray();
        for (var index = 0; index < Math.Min(writtenItems.Length, producedItems.Length); index++)
        {
            if (Difference(writtenItems[index], producedItems[index], $"{path}[{index}]") is { } found) return found;
        }
        return writtenItems.Length == producedItems.Length ? null : path;
    }

    private static string Member(string path, string name) => path == Root ? name : $"{path}.{name}";
}
