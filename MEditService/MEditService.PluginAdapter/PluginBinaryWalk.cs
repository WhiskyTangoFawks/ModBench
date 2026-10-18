using System.Buffers.Binary;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Masters;
using Mutagen.Bethesda.Plugins.Meta;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's records and subrecords as Mutagen's frame reader reads them, free of its typed
/// parse, shared by init's tripwire and the Repair surface (ADR-0006).</summary>
public static class PluginBinaryWalk
{
    /// <summary>A record whose rewrite has fewer occurrences of some subrecord signatures than the
    /// original. <c>FormId</c> is the original's stored FormID, as a diagnosis of its bytes anchors it.</summary>
    public readonly record struct SubrecordLoss(string RecordType, uint FormId, FormKey FormKey, IReadOnlyList<string> Signatures);

    /// <summary>One record of a plugin and of its rewrite.</summary>
    internal readonly record struct RecordPair(FormKey FormKey, MajorRecordFrame Original, MajorRecordFrame Rewritten);

    /// <summary>The records a plugin and its rewrite both hold, and the first original record the rewrite lacks.</summary>
    internal readonly record struct Pairing(List<RecordPair> Pairs, string? FirstMissing);

    /// <summary>The records a plugin and its rewrite both hold, paired by type and FormKey, each FormID read
    /// through its own plugin's masters: a rewrite prunes unneeded masters, which moves every index after
    /// them.</summary>
    internal static Pairing PairByFormKey(
        byte[] original, IReadOnlySeparatedMasterPackage originalMasters, byte[] rewritten, IReadOnlySeparatedMasterPackage rewrittenMasters,
        GameRelease release)
    {
        var rewrittenByIdentity = new Dictionary<(RecordType Type, FormKey FormKey), MajorRecordFrame>();
        foreach (var record in Records(rewritten, release))
            rewrittenByIdentity.TryAdd((record.RecordType, IdentityOf(record, rewrittenMasters)), record);

        var pairs = new List<RecordPair>();
        string? firstMissing = null;
        foreach (var record in Records(original, release))
        {
            var formKey = IdentityOf(record, originalMasters);
            if (rewrittenByIdentity.TryGetValue((record.RecordType, formKey), out var partner))
                pairs.Add(new RecordPair(formKey, record, partner));
            else
                firstMissing ??= $"{record.RecordType} {formKey}";
        }
        return new Pairing(pairs, firstMissing);
    }

    // The header's FormID is no reference: read through masters it names whichever plugin holds index 0.
    private static FormKey IdentityOf(MajorRecordFrame record, IReadOnlySeparatedMasterPackage masters) =>
        record.RecordType.Type == "TES4" ? FormKey.Null : masters.GetFormKey(record.FormID, reference: false);

    /// <summary>How the plugin's FormIDs name records: through its own masters, each in the style the load
    /// order's copy of it carries.</summary>
    internal static IReadOnlySeparatedMasterPackage MastersOf(ModPath plugin, LoadOrderSnapshot loadOrder) =>
        SeparatedMasterPackage.Factory(loadOrder.GameRelease, plugin, MasterStyles.Of(plugin, loadOrder));

    /// <summary>The first record flagged Deleted that holds subrecords in the original and none in its
    /// rewrite, as Mutagen writes most deleted records.</summary>
    internal static RecordPair? FirstEmptiedDeletedRecord(IEnumerable<RecordPair> pairs) =>
        pairs.Cast<RecordPair?>().FirstOrDefault(pair => pair is { } p
            && p.Original.IsDeleted && p.Original.ContentLength > 0 && p.Rewritten.ContentLength == 0);

    /// <summary>Every record, the plugin header first, in document order. A GRUP's children follow its
    /// header: the format nests by adjacency, so stepping over the header alone descends.</summary>
    internal static IEnumerable<MajorRecordPinFrame> Records(byte[] pluginBytes, GameRelease release)
    {
        var constants = GameConstants.Get(release);
        var bytes = new ReadOnlyMemorySlice<byte>(pluginBytes);
        var position = 0;
        while (position < pluginBytes.Length)
        {
            var rest = bytes.Slice(position);
            if (constants.VariableHeader(rest).IsGroup)
            {
                position += constants.GroupConstants.HeaderLength;
                continue;
            }
            var record = new MajorRecordPinFrame(constants, rest, position);
            yield return record;
            position += checked((int)record.TotalLength);
        }
    }

    /// <summary>The record's subrecords, decompressed first when it is compressed. Null for a compressed
    /// record whose stream does not inflate to the length it declares: an unreadable stream is a
    /// different failure than the ones its callers name.</summary>
    internal static List<SubrecordPinFrame>? Subrecords(MajorRecordFrame record)
    {
        if (record.IsCompressed)
        {
            if (!DeclaresALengthItsBytesCanInflateTo(record)) return null;
            try
            {
                record = record.Decompress(out _);
            }
            catch (Exception ex) when (ex is InvalidDataException or EndOfStreamException)
            {
                return null;
            }
        }
        return [.. record.EnumerateSubrecords()];
    }

    // Mutagen allocates the declared length before it inflates, and zlib expands its input at most
    // 1032 times.
    private const long ZlibMostExpansion = 1032;

    /// <summary>Whether a compressed record's declared length is one its zlib stream could inflate to.</summary>
    internal static bool DeclaresALengthItsBytesCanInflateTo(MajorRecordFrame record) =>
        record.Content.Length >= sizeof(uint)
        && BinaryPrimitives.ReadUInt32LittleEndian(record.Content) <= Math.Min(Array.MaxLength, (record.Content.Length - sizeof(uint)) * ZlibMostExpansion);

    // Order and content are model identity's concern, and a signature the rewrite has more of, a
    // canonical marker insertion, is not loss.
    private static List<string> DroppedSignatures(List<SubrecordPinFrame> original, List<SubrecordPinFrame> rewritten)
    {
        var originalCounts = CountBySignature(original);
        var rewrittenCounts = CountBySignature(rewritten);

        return original
            .Select(sub => sub.RecordType.Type)
            .Distinct(StringComparer.Ordinal)
            .Where(sig => rewrittenCounts.GetValueOrDefault(sig) < originalCounts[sig])
            .ToList();
    }

    private static Dictionary<string, int> CountBySignature(List<SubrecordPinFrame> subrecords) =>
        subrecords
            .GroupBy(sub => sub.RecordType.Type, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

    private static (List<SubrecordPinFrame>, List<SubrecordPinFrame>)? SubrecordsOfBoth(MajorRecordFrame original, MajorRecordFrame rewritten) =>
        original.IsCompressed == rewritten.IsCompressed
        && Subrecords(original) is { } originalSubrecords
        && Subrecords(rewritten) is { } rewrittenSubrecords
            ? (originalSubrecords, rewrittenSubrecords)
            : null;

    /// <summary>The first original record whose rewrite is absent, or whose pair the subrecord check cannot
    /// read.</summary>
    internal static string? FirstUnverified(Pairing pairing)
    {
        if (pairing.FirstMissing is { } missing)
            return $"{missing} is absent from the rewrite";

        var unread = pairing.Pairs.Cast<RecordPair?>().FirstOrDefault(pair => pair is { } p && SubrecordsOfBoth(p.Original, p.Rewritten) is null);
        return unread is { } u ? $"{u.Original.RecordType} {u.FormKey} could not be compared with its rewrite" : null;
    }

    /// <summary>The first paired record whose subrecord inventory shows a drop, or null. TES4's MAST/DATA
    /// are exempt (ADR-0008).</summary>
    internal static SubrecordLoss? FindFirstSubrecordLoss(IEnumerable<RecordPair> pairs)
    {
        foreach (var (formKey, original, rewritten) in pairs)
        {
            if (SubrecordsOfBoth(original, rewritten) is not var (originalSubrecords, rewrittenSubrecords))
                continue;

            var type = original.RecordType.Type;
            var dropped = DroppedSignatures(originalSubrecords, rewrittenSubrecords);
            if (type == "TES4")
                dropped = dropped.Where(sig => sig is not ("MAST" or "DATA")).ToList();
            if (dropped.Count > 0)
                return new SubrecordLoss(type, original.FormID.Raw, formKey, dropped);
        }

        return null;
    }
}
