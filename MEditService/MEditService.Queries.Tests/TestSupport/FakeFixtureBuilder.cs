using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>Everything a built fixture hands the test: the load order's own copies, what the Index
/// would have opened, and the documents each copy holds.</summary>
internal sealed record FakeFixtureData(
    GameRelease Release,
    IReadOnlyList<RegisteredCopy> Copies, IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies, IReadOnlyList<FakeRow> Rows);

// Build takes the column names a test reads, never every column a schema has: a scratch round
// trip runs Mutagen's own master computation, then the real codec serializes each record once.
internal sealed class FakeFixtureBuilder(GameRelease release = GameRelease.Fallout4)
{
    private readonly List<(string Name, bool Listed, bool Enabled, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> Configure, string Origin)> _plugins = [];

    internal FakeFixtureBuilder WithPlugin(
        string name, Action<Fallout4Mod>? configure = null, bool listed = true, bool enabled = true, string origin = "Data")
    {
        _plugins.Add((name, listed, enabled, configure is null ? (_, _) => { } : (mod, _) => configure(mod), origin));
        return this;
    }

    internal FakeFixtureBuilder WithPlugin(
        string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, bool listed = true, bool enabled = true, string origin = "Data")
    {
        _plugins.Add((name, listed, enabled, configure, origin));
        return this;
    }

    internal FakeFixtureData Build(params string[] fieldNames)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        var scratch = Directory.CreateTempSubdirectory("medit-fake-fixture-");
        var overlays = new List<IModDisposeGetter>();
        try
        {
            var builtMods = new List<Fallout4Mod>();
            var copies = new List<RegisteredCopy>();
            var opened = new Dictionary<PluginCopyKey, PluginContent>();
            var perPlugin = new List<(PluginCopyKey Key, int Slot, List<(IMajorRecordGetter Record, string RecordType)> Records)>();

            for (var slot = 0; slot < _plugins.Count; slot++)
            {
                var (name, listed, enabled, configure, origin) = _plugins[slot];
                var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
                configure(mod, builtMods.AsReadOnly());
                builtMods.Add(mod);

                // The round trip Mutagen's own master computation needs: a bare in-memory FormLink
                // carries no master until a real write derives one from the object graph.
                var scratchPath = Path.Combine(scratch.FullName, name);
                mod.WriteToBinary(scratchPath);
                var overlay = ModFactory.ImportGetter(new ModPath(ModKey.FromFileName(name), scratchPath), release);
                overlays.Add(overlay);
                var written = (IFallout4ModGetter)overlay;

                var key = new PluginCopyKey(name, origin);
                var masters = written.ModHeader.MasterReferences.Select(m => m.Master.FileName.String).ToList();
                var records = written.EnumerateMajorRecords()
                    .Select(r => (Record: r, RecordType: RecordTableName.Of(r, schemas)))
                    .Where(t => t.RecordType.Length > 0)
                    .ToList();

                opened[key] = new PluginContent(
                    written.IsSmallMaster, IsMaster: masters.Count == 0 && records.Count > 0, masters, records.Count);
                if (listed) copies.Add(new RegisteredCopy(name, origin, name, slot, enabled, Winning: true));
                perPlugin.Add((key, slot, records));
            }

            var winners = Winners(copies, perPlugin);
            RecordLookupEntry? Resolve(string formKey) =>
                winners.TryGetValue(formKey, out var winner) ? new RecordLookupEntry(winner.RecordType, winner.Record.EditorID) : null;

            var rows = new List<FakeRow>();
            foreach (var (key, slot, records) in perPlugin)
            {
                foreach (var (record, recordType) in records)
                {
                    var isWinner = winners.TryGetValue(record.FormKey.ToString(), out var winner) && winner.Slot == slot;
                    rows.Add(new FakeRow(key, slot, isWinner, RealDocuments.Of(record, key, slot, isWinner, release, recordType, fieldNames, Resolve)));
                }
            }

            return new FakeFixtureData(release, copies, opened, rows);
        }
        finally
        {
            foreach (var overlay in overlays) overlay.Dispose();
            try { Directory.Delete(scratch.FullName, recursive: true); } catch (IOException) { /* scratch, best-effort */ }
        }
    }

    // ADR-0013's rule, applied the same way the indexer's own sweep applies it: the winner of a
    // FormKey is the highest-slot copy whose plugin participates.
    private static Dictionary<string, (int Slot, IMajorRecordGetter Record, string RecordType)> Winners(
        List<RegisteredCopy> copies, List<(PluginCopyKey Key, int Slot, List<(IMajorRecordGetter Record, string RecordType)> Records)> perPlugin)
    {
        var participates = copies.Where(c => c.Registration.Participates).Select(c => new PluginCopyKey(c.Name, c.Origin)).ToHashSet();
        var winners = new Dictionary<string, (int Slot, IMajorRecordGetter Record, string RecordType)>(StringComparer.Ordinal);
        foreach (var (key, slot, records) in perPlugin)
        {
            if (!participates.Contains(key)) continue;
            foreach (var (record, recordType) in records)
            {
                var formKey = record.FormKey.ToString();
                if (!winners.TryGetValue(formKey, out var current) || slot > current.Slot)
                    winners[formKey] = (slot, record, recordType);
            }
        }
        return winners;
    }
}
