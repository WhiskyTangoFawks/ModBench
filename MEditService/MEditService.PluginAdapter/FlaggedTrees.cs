using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Repair;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

/// <summary>Decompile and repair's first commit: each repaired record typed, but for the members a repaired subrecord
/// feeds, which hold the original's subrecords. A member feeds what Mutagen stops writing when it goes.</summary>
internal static class FlaggedTrees
{
    /// <summary>A record the first commit flags, by its FormKey: its diagnoses, its subrecords as the plugin holds them,
    /// and its repair.</summary>
    internal sealed record FlaggedRecord(string FormKey, IReadOnlyList<string> Diagnoses, IReadOnlyList<Subrecord> Original, RecordRewrite Repair);

    private static readonly string[] NeverHeld = [LoquiUnions.UnionTypeDiscriminator, RecordMembers.FormKey];

    /// <summary><paramref name="repaired"/>'s files with the document of each of <paramref name="flagged"/>, its own or
    /// embedded in its container's, flagged, and every other byte as it was.</summary>
    internal static async Task<IReadOnlyList<TreeFile>> FlaggedAsync(
        string pluginName, PluginSource repaired, IReadOnlyList<FlaggedRecord> flagged, LoadOrderSnapshot loadOrder, CancellationToken cancel)
    {
        var release = loadOrder.GameRelease;
        var tree = repaired.Files.ToList();
        var header = tree.Single(file => file.RelativePath == DocumentFileNames.Root);
        foreach (var record in flagged)
        {
            var at = tree.FindIndex(file => Carries(file, record.FormKey, release));
            if (at < 0) throw new InvalidOperationException($"Expected the repaired plugin's tree to carry {record.FormKey}, which its repair flags.");
            var carried = Carried.In(tree[at], record.FormKey, release);
            var writer = new RecordWriter(pluginName, header, carried, record.FormKey, repaired.Masters, loadOrder, cancel);
            var flaggedText = await RawMembersAsync(carried.Text, record, writer) is { } raw
                ? FlaggedDocument.WithMembersHeldRaw(carried.Text, record.Diagnoses, raw)
                : FlaggedDocument.For(carried.Text, record.Diagnoses, Payloads(record.Original));
            tree[at] = carried.With(flaggedText);
        }
        return tree;
    }

    // Null holds the whole record raw: a repair that drops a subrecord, or a repaired subrecord no member feeds.
    private static async Task<Dictionary<string, IReadOnlyList<(string Signature, ReadOnlyMemory<byte> Payload)>>?> RawMembersAsync(
        string recordText, FlaggedRecord record, RecordWriter writer)
    {
        if (record.Repair.DropsAny) return null;
        var placed = record.Repair.Placing();
        if (await writer.SubrecordsOfAsync(recordText) is not { } written
            || !written.SequenceEqual(placed.Select(p => p.Subrecord), SameSubrecord.Instance))
            return null;

        var changed = Enumerable.Range(0, placed.Count).Where(at => placed[at].Changed).ToHashSet();
        var fedBy = new Dictionary<string, HashSet<int>>(StringComparer.Ordinal);
        foreach (var member in FlaggedDocument.MembersOf(recordText).Except(NeverHeld, StringComparer.Ordinal))
        {
            if (await writer.SubrecordsOfAsync(FlaggedDocument.WithoutMember(recordText, member)) is { } without)
                fedBy[member] = Gone(written, without);
        }
        if (changed.Any(at => !fedBy.Values.Any(fed => fed.Contains(at)))) return null;

        return fedBy.Where(member => member.Value.Overlaps(changed)).ToDictionary(
            member => member.Key,
            member => (IReadOnlyList<(string, ReadOnlyMemory<byte>)>)Payloads(
                [.. member.Value.Select(at => placed[at].Original).OfType<int>().Order().Select(at => record.Original[at])]),
            StringComparer.Ordinal);
    }

    // What the written subrecords hold and those without the member lack, by their longest common subsequence: a member's
    // subrecords go, and a count or an order it shares changes.
    private static HashSet<int> Gone(List<Subrecord> written, List<Subrecord> without)
    {
        var common = new int[written.Count + 1, without.Count + 1];
        for (var i = written.Count - 1; i >= 0; i--)
        {
            for (var j = without.Count - 1; j >= 0; j--)
                common[i, j] = written[i].SameAs(without[j]) ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
        }

        var gone = new HashSet<int>();
        var (w, o) = (0, 0);
        while (w < written.Count)
        {
            if (o < without.Count && written[w].SameAs(without[o])) (w, o) = (w + 1, o + 1);
            else if (o < without.Count && common[w, o + 1] >= common[w + 1, o]) o++;
            else gone.Add(w++);
        }
        return gone;
    }

    private static List<(string Signature, ReadOnlyMemory<byte> Payload)> Payloads(IEnumerable<Subrecord> subrecords) =>
        [.. subrecords.Select(subrecord => (subrecord.Signature, (ReadOnlyMemory<byte>)subrecord.Payload.ToArray()))];

    private static bool Carries(TreeFile file, string formKey, GameRelease release) =>
        DocumentTokens.FormKeysIn(file.Content, release)
            .Any(key => key.Position != FormKeyPosition.Other && FormKeyComparer.Instance.Equals(key.FormKey, formKey));

    // A record's own text in the file carrying it: the file's own, or a child's span in its container's.
    private sealed record Carried(TreeFile Owner, EmbeddedChildSpan? Span, string Text)
    {
        internal static Carried In(TreeFile file, string formKey, GameRelease release)
        {
            if (DocumentTokens.FormKeysIn(file.Content, release).FirstOrDefault(key => key.Position == FormKeyPosition.Root) is { } root
                && FormKeyComparer.Instance.Equals(root.FormKey, formKey))
                return new Carried(file, null, Encoding.UTF8.GetString(file.Content));
            var span = ContainerDocumentEdits.EmbeddedChildSpansOf(file.Content, ownerRecordType: null, release)[formKey];
            return new Carried(file, span, ContainerDocumentEdits.ChildTextAt(file.Content, span, release));
        }

        internal TreeFile With(string text) => Owner with
        {
            Content = Encoding.UTF8.GetBytes(Span is { } span ? ContainerDocumentEdits.WithChildReplaced(Owner.Content, span, text) : text),
        };
    }

    // The subrecords Mutagen writes for one record's text, compiled with the plugin's header alone. Null when the text
    // does not compile, which says nothing of which subrecords its members feed.
    private sealed class RecordWriter(
        string pluginName, TreeFile header, Carried carried, string formKey, IReadOnlyList<string> masters, LoadOrderSnapshot loadOrder,
        CancellationToken cancel)
    {
        internal async Task<List<Subrecord>?> SubrecordsOfAsync(string recordText)
        {
            using var scratch = ScratchPlugin.For(pluginName);
            try
            {
                if (!(await PluginTrees.WriteFromTreeAsync([header, carried.With(recordText)], scratch.PluginPath, masters, loadOrder, cancel))
                        .Holds(out var written, out _))
                    return null;
                var bytes = await File.ReadAllBytesAsync(written, cancel);
                var identities = PluginBinaryWalk.MastersOf(new ModPath(ModKey.FromFileName(pluginName), written), loadOrder);
                return PluginBinaryWalk.Records(bytes, loadOrder.GameRelease)
                    .Where(record => FormKeyComparer.Instance.Equals(identities.GetFormKey(record.FormID, reference: false).ToString(), formKey))
                    .Select(record => PluginBinaryWalk.Subrecords(record)?.Select(Subrecord.Of).ToList())
                    .FirstOrDefault();
            }
            catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
            {
                return null;
            }
        }
    }

    private sealed class SameSubrecord : IEqualityComparer<Subrecord>
    {
        internal static readonly SameSubrecord Instance = new();

        public bool Equals(Subrecord x, Subrecord y) => x.SameAs(y);

        public int GetHashCode(Subrecord obj) => obj.Signature.GetHashCode(StringComparison.Ordinal);
    }
}
