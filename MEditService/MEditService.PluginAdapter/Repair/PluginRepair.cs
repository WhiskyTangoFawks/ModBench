using System.Buffers.Binary;
using System.IO.Compression;
using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Binary.Headers;

namespace MEditService.PluginAdapter.Repair;

/// <summary>The repair engine: a malformed plugin's records rewritten at the byte level, since Mutagen
/// cannot read them as they are.</summary>
internal static class PluginRepair
{
    // A record's or group's header opens with its four-byte type, then its length.
    private const int LengthAt = 4;
    private const int IdentityAt = 8;

    private sealed record PlannedRecord(MajorRecordPinFrame Record, List<Subrecord> Subrecords);

    internal static RepairPreviews Preview(byte[] plugin, GameRelease release) =>
        new(PluginBinaryHash.OfBytes(plugin), [.. Malformations.In(plugin, release).Select(found => found.Preview)]);

    /// <summary>The plugin with the repair of each of <paramref name="chosen"/> made.</summary>
    internal static Answer<byte[], PluginFailure> Repaired(
        byte[] plugin, string previewedHash, IReadOnlyCollection<PluginDiagnosis> chosen, GameRelease release)
    {
        if (!Planned(plugin, previewedHash, chosen, release).Holds(out var planned, out var refused)) return refused;
        return Spliced(plugin, release, planned.ToDictionary(
            p => p.Key, p => (OriginalLength: checked((int)p.Value.Record.TotalLength), Bytes: RecordBytes(plugin, p.Value))));
    }

    /// <summary>Null when <paramref name="repaired"/> holds every record of <paramref name="original"/>, and
    /// differs from it only by the repairs of <paramref name="chosen"/>; otherwise the refusal naming the first
    /// record that does not.</summary>
    internal static PluginFailure? Unverified(
        byte[] original, string previewedHash, IReadOnlyCollection<PluginDiagnosis> chosen, byte[] repaired, GameRelease release)
    {
        if (!Planned(original, previewedHash, chosen, release).Holds(out var planned, out var refused)) return refused;
        var before = PluginBinaryWalk.Records(original, release).ToList();
        var after = PluginBinaryWalk.Records(repaired, release).ToList();
        if (before.Count != after.Count)
            return new PluginFailure.RepairUnverified($"the repaired plugin holds {after.Count} records where the plugin holds {before.Count}");

        foreach (var (was, now) in before.Zip(after))
        {
            var expected = planned.GetValueOrDefault(was.Location)?.Subrecords ?? SubrecordsOf(was);
            var actual = SubrecordsOf(now);
            var sameSubrecords = expected is null
                ? was.Frame.Content.Span.SequenceEqual(now.Frame.Content.Span)
                : actual is not null && expected.Count == actual.Count && expected.Zip(actual).All(pair => pair.First.SameAs(pair.Second));
            if (!sameSubrecords || !SameIdentity(original, was, repaired, now))
                return new PluginFailure.RepairUnverified($"the repaired plugin's {was.RecordType} {was.FormID.Raw:X8} is not the one its repair planned");
        }
        return null;
    }

    private static Answer<Dictionary<int, PlannedRecord>, PluginFailure> Planned(
        byte[] plugin, string previewedHash, IReadOnlyCollection<PluginDiagnosis> chosen, GameRelease release)
    {
        if (PluginBinaryHash.OfBytes(plugin) != previewedHash) return new PluginFailure.ChangedSincePreview();
        var repairing = Malformations.In(plugin, release).Where(found => chosen.Contains(found.Diagnosis)).ToList();
        if (chosen.FirstOrDefault(diagnosis => repairing.All(found => found.Diagnosis != diagnosis)) is { } absent)
            throw new ArgumentException($"A diagnosis chosen for repair is one its preview made, and {absent.Describe()} is not.", nameof(chosen));
        if (repairing.FirstOrDefault(found => found.Repair is null) is { } unanswered) return new PluginFailure.NoRepair(unanswered.Diagnosis);

        return repairing
            .GroupBy(found => found.Record.Location)
            .ToDictionary(record => record.Key, record =>
            {
                var rewrite = new RecordRewrite(record.First().Subrecords);
                foreach (var edit in record.SelectMany(found => found.Repair ?? [])) edit.ApplyTo(rewrite);
                return new PlannedRecord(record.First().Record, rewrite.Result());
            });
    }

    private static byte[] RecordBytes(byte[] plugin, PlannedRecord planned)
    {
        var record = planned.Record;
        using var content = new MemoryStream();
        foreach (var subrecord in planned.Subrecords) subrecord.WriteTo(content);
        var data = record.IsCompressed ? Compressed(content.ToArray()) : content.ToArray();

        var bytes = new byte[record.HeaderLength + data.Length];
        plugin.AsSpan(record.Location, record.HeaderLength).CopyTo(bytes);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(LengthAt), (uint)data.Length);
        data.CopyTo(bytes, record.HeaderLength);
        return bytes;
    }

    // A compressed record's content is its inflated length, then the zlib stream.
    private static byte[] Compressed(byte[] inflated)
    {
        using var content = new MemoryStream();
        Span<byte> length = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32LittleEndian(length, (uint)inflated.Length);
        content.Write(length);
        using (var zlib = new ZLibStream(content, CompressionLevel.Optimal, leaveOpen: true))
            zlib.Write(inflated);
        return content.ToArray();
    }

    private static byte[] Spliced(byte[] plugin, GameRelease release, Dictionary<int, (int OriginalLength, byte[] Bytes)> replacements)
    {
        var patched = (byte[])plugin.Clone();
        foreach (var (record, groupStarts) in PluginBinaryWalk.RecordsInGroups(plugin, release))
        {
            if (!replacements.TryGetValue(record.Location, out var replacement)) continue;
            foreach (var start in groupStarts)
            {
                var size = BinaryPrimitives.ReadUInt32LittleEndian(patched.AsSpan(start + LengthAt));
                BinaryPrimitives.WriteUInt32LittleEndian(patched.AsSpan(start + LengthAt),
                    checked((uint)(size + replacement.Bytes.Length - replacement.OriginalLength)));
            }
        }

        using var spliced = new MemoryStream();
        var copied = 0;
        foreach (var (at, replacement) in replacements.OrderBy(r => r.Key))
        {
            spliced.Write(patched, copied, at - copied);
            spliced.Write(replacement.Bytes);
            copied = at + replacement.OriginalLength;
        }
        spliced.Write(patched, copied, patched.Length - copied);
        return spliced.ToArray();
    }

    private static List<Subrecord>? SubrecordsOf(MajorRecordPinFrame record) =>
        PluginBinaryWalk.Subrecords(record)?.Select(Subrecord.Of).ToList();

    private static bool SameIdentity(byte[] original, MajorRecordPinFrame was, byte[] repaired, MajorRecordPinFrame now) =>
        original.AsSpan(was.Location, LengthAt).SequenceEqual(repaired.AsSpan(now.Location, LengthAt))
        && original.AsSpan(was.Location + IdentityAt, was.HeaderLength - IdentityAt)
            .SequenceEqual(repaired.AsSpan(now.Location + IdentityAt, now.HeaderLength - IdentityAt));
}
