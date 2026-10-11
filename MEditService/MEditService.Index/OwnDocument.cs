using System.Text;
using System.Text.Json;

namespace MEditService.Index;

/// <summary>A container's document as the index stores it: each child slot cut, every other byte as it
/// stands. The codec spells a cleared slot by omitting it, so this is the document an own-fields copy lands.</summary>
internal static class OwnDocument
{
    public static string Of(string text, IReadOnlyList<string> childSlots)
    {
        if (childSlots.Count == 0) return text;

        var bytes = Encoding.UTF8.GetBytes(text);
        var cuts = Merged(SlotCuts(bytes, childSlots));
        if (cuts.Count == 0) return text;

        var kept = new List<byte>(bytes.Length);
        var from = 0;
        foreach (var (start, end) in cuts)
        {
            kept.AddRange(bytes.AsSpan(from, start - from));
            from = end;
        }
        kept.AddRange(bytes.AsSpan(from));
        return Encoding.UTF8.GetString(kept.ToArray());
    }

    private readonly record struct Member(string Name, int NameStart, int ValueEnd);

    // A slot after a kept member goes with the comma before it; one with no kept member before it
    // goes with the comma after it, up to the next member, so the indentation before it stays the
    // next member's.
    private static List<(int Start, int End)> SlotCuts(byte[] bytes, IReadOnlyList<string> childSlots)
    {
        var members = TopLevelMembers(bytes);
        var cuts = new List<(int Start, int End)>();
        int? lastKeptEnd = null;
        for (var i = 0; i < members.Count; i++)
        {
            var member = members[i];
            if (!childSlots.Contains(member.Name, StringComparer.Ordinal))
            {
                lastKeptEnd = member.ValueEnd;
                continue;
            }
            if (lastKeptEnd is { } keptEnd) cuts.Add((keptEnd, member.ValueEnd));
            else cuts.Add((member.NameStart, i + 1 < members.Count ? members[i + 1].NameStart : member.ValueEnd));
        }
        return cuts;
    }

    private static List<Member> TopLevelMembers(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes);
        reader.Read();
        var members = new List<Member>();
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var nameStart = (int)reader.TokenStartIndex;
            var name = reader.GetString() ?? "";
            reader.Read();
            reader.Skip();
            members.Add(new Member(name, nameStart, (int)reader.BytesConsumed));
        }
        return members;
    }

    // Each cut after one kept member starts where that member ends, so a later one covers an earlier one.
    private static List<(int Start, int End)> Merged(List<(int Start, int End)> cuts)
    {
        var merged = new List<(int Start, int End)>();
        foreach (var cut in cuts.OrderBy(c => c.Start))
        {
            if (merged.Count > 0 && cut.Start <= merged[^1].End)
                merged[^1] = (merged[^1].Start, Math.Max(merged[^1].End, cut.End));
            else merged.Add(cut);
        }
        return merged;
    }
}
