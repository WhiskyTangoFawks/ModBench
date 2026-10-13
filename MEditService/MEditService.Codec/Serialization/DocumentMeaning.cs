using System.Globalization;
using System.Numerics;
using System.Text.Json;

namespace MEditService.Codec.Serialization;

/// <summary>Whether two documents mean the same: JSON values equal, spacing and key order aside.</summary>
public static class DocumentMeaning
{
    private const string Root = "the document";

    /// <summary>The path of the first member where <paramref name="held"/> differs in meaning from
    /// <paramref name="produced"/>, or null when they mean the same. Non-JSON differs at the whole document.</summary>
    public static string? FirstDifference(byte[] held, byte[] produced)
    {
        if (held.AsSpan().SequenceEqual(produced)) return null;
        try
        {
            using var written = JsonDocument.Parse(held);
            using var read = JsonDocument.Parse(produced);
            return FirstDifference(written.RootElement, read.RootElement);
        }
        catch (JsonException)
        {
            return Root;
        }
    }

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
            JsonValueKind.Number => NumbersAgree(written, produced) ? null : path,
            _ => null,
        };
    }

    // Integers by their digits, so none is rounded to a double. Any other number is the float the codec reads it as.
    private static bool NumbersAgree(JsonElement written, JsonElement produced) =>
        IsInteger(written) && IsInteger(produced)
            ? BigInteger.Parse(written.GetRawText(), CultureInfo.InvariantCulture) == BigInteger.Parse(produced.GetRawText(), CultureInfo.InvariantCulture)
            : written.GetDouble().Equals(produced.GetDouble()) || SameSingle(written, produced);

    private static bool IsInteger(JsonElement number) => number.GetRawText().AsSpan().IndexOfAny(".eE") < 0;

    private static bool SameSingle(JsonElement written, JsonElement produced) =>
        written.TryGetSingle(out var first) && produced.TryGetSingle(out var second) && first.Equals(second);

    private static string? ObjectDifference(JsonElement written, JsonElement produced, string path)
    {
        foreach (var member in written.EnumerateObject())
        {
            var memberPath = Member(path, member.Name);
            if (!produced.TryGetProperty(member.Name, out var counterpart)) return IsEmptyList(member.Value) ? null : memberPath;
            if (Difference(member.Value, counterpart, memberPath) is { } found) return found;
        }
        return produced.EnumerateObject().Where(member => !IsEmptyList(member.Value)).Select(member => member.Name)
            .FirstOrDefault(name => !written.TryGetProperty(name, out _)) is { } extra
            ? Member(path, extra)
            : null;
    }

    // The codec writes no empty list, and a list left empty means the list left out.
    private static bool IsEmptyList(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;

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
