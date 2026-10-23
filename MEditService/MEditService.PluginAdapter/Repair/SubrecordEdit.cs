using System.Buffers.Binary;

namespace MEditService.PluginAdapter.Repair;

/// <summary>One of the repair engine's five byte operations on a record's subrecords, each named by its
/// index in the record as read, so the edits of several repairs to one record compose.</summary>
internal abstract record SubrecordEdit
{
    internal abstract void ApplyTo(RecordRewrite rewrite);

    internal abstract string Describe(IReadOnlyList<Subrecord> original);

    internal virtual int DroppedBytes(IReadOnlyList<Subrecord> original) => 0;

    private protected static string Placed(IReadOnlyList<Subrecord> original, int index) =>
        index < original.Count ? $"before {original[index].Signature}" : "at the record's end";

    private protected static string Bytes(int count) => count == 1 ? "1 byte" : $"{count} bytes";
}

internal sealed record Reorder(int Index, int Before) : SubrecordEdit
{
    internal override void ApplyTo(RecordRewrite rewrite) => rewrite.Move(Index, Before);

    internal override string Describe(IReadOnlyList<Subrecord> original) =>
        $"moves {original[Index].Signature} {Placed(original, Before)}";
}

internal sealed record Pad(int Index, int Length) : SubrecordEdit
{
    internal override void ApplyTo(RecordRewrite rewrite)
    {
        var padded = new byte[Length];
        rewrite[Index].Payload.Span.CopyTo(padded);
        rewrite[Index] = rewrite[Index] with { Payload = padded };
    }

    internal override string Describe(IReadOnlyList<Subrecord> original) =>
        $"pads {original[Index].Signature} from {original[Index].Payload.Length} to {Bytes(Length)} with zeros";
}

internal sealed record Recount(int Index, uint Count) : SubrecordEdit
{
    internal override void ApplyTo(RecordRewrite rewrite)
    {
        var payload = rewrite[Index].Payload.ToArray();
        BinaryPrimitives.WriteUInt32LittleEndian(payload, Count);
        rewrite[Index] = rewrite[Index] with { Payload = payload };
    }

    internal override string Describe(IReadOnlyList<Subrecord> original) =>
        $"sets {original[Index].Signature} from {BinaryPrimitives.ReadUInt32LittleEndian(original[Index].Payload)} to {Count}";
}

internal sealed record InsertDefault(int Before, string Signature, int Length, int Count) : SubrecordEdit
{
    internal override void ApplyTo(RecordRewrite rewrite)
    {
        for (var i = 0; i < Count; i++) rewrite.Insert(Before, Subrecord.Zeroed(Signature, Length));
    }

    internal override string Describe(IReadOnlyList<Subrecord> original) =>
        $"inserts {Count} zeroed {Signature} of {Bytes(Length)} {Placed(original, Before)}";
}

internal sealed record Drop(IReadOnlyList<int> Indexes) : SubrecordEdit
{
    internal override void ApplyTo(RecordRewrite rewrite)
    {
        foreach (var index in Indexes) rewrite.Drop(index);
    }

    internal override string Describe(IReadOnlyList<Subrecord> original) =>
        $"drops {string.Join(", ", Indexes.Select(i => original[i].Signature))} ({Bytes(DroppedBytes(original))})";

    internal override int DroppedBytes(IReadOnlyList<Subrecord> original) => Indexes.Sum(i => original[i].TotalLength);
}

/// <summary>A record's subrecords as its edits leave them. Each edit names a subrecord by its index in
/// the original, so the order edits apply in changes nothing.</summary>
internal sealed class RecordRewrite(IReadOnlyList<Subrecord> original)
{
    /// <summary>A subrecord of the rewritten record, the index in the original it came from, null for one inserted,
    /// and whether an edit changed it or moved it.</summary>
    internal readonly record struct Placed(Subrecord Subrecord, int? Original, bool Changed);

    private readonly Subrecord[] _content = [.. original];
    private readonly int[] _placedBefore = [.. Enumerable.Range(0, original.Count)];
    private readonly bool[] _dropped = new bool[original.Count];
    private readonly List<Subrecord>[] _inserted = [.. Enumerable.Range(0, original.Count + 1).Select(_ => new List<Subrecord>())];

    internal Subrecord this[int index]
    {
        get => _content[index];
        set => _content[index] = value;
    }

    internal void Move(int index, int before) => _placedBefore[index] = before;

    internal void Drop(int index) => _dropped[index] = true;

    internal void Insert(int before, Subrecord subrecord) => _inserted[before].Add(subrecord);

    internal List<Subrecord> Result() => [.. Placing().Select(placed => placed.Subrecord)];

    internal bool DropsAny => _dropped.Any(dropped => dropped);

    internal List<Placed> Placing()
    {
        var result = new List<Placed>();
        for (var at = 0; at <= _content.Length; at++)
        {
            for (var moved = 0; moved < _content.Length; moved++)
            {
                if (moved != at && _placedBefore[moved] == at && !_dropped[moved]) result.Add(new Placed(_content[moved], moved, Changed: true));
            }
            result.AddRange(_inserted[at].Select(inserted => new Placed(inserted, Original: null, Changed: true)));
            if (at < _content.Length && _placedBefore[at] == at && !_dropped[at])
                result.Add(new Placed(_content[at], at, Changed: !_content[at].SameAs(original[at])));
        }
        return result;
    }
}
