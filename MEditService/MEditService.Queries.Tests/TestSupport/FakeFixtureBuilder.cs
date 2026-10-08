using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>Everything a built fixture hands the test: the load order's own plugins, what the Index
/// would have opened, and the documents each plugin holds.</summary>
internal sealed record FakeFixtureData(
    GameRelease Release,
    IReadOnlyList<LoadOrderEntry> Plugins, IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins, IReadOnlyList<FakeRow> Rows);

// A scratch round trip runs Mutagen's own master computation, then the real codec serializes each
// record once.
internal sealed class FakeFixtureBuilder(GameRelease release = GameRelease.Fallout4)
{
    private readonly List<(string Name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> Configure, string Origin)> _plugins = [];

    internal FakeFixtureBuilder WithPlugin(string name, Action<Fallout4Mod>? configure = null, string origin = PluginOrigin.DataDirectory)
    {
        _plugins.Add((name, configure is null ? (_, _) => { } : (mod, _) => configure(mod), origin));
        return this;
    }

    internal FakeFixtureBuilder WithPlugin(
        string name, Action<Fallout4Mod, IReadOnlyList<Fallout4Mod>> configure, string origin = PluginOrigin.DataDirectory)
    {
        _plugins.Add((name, configure, origin));
        return this;
    }

    internal FakeFixtureData Build()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        using var scratch = new ScratchDirectory("medit-fake-fixture-");
        var overlays = new List<IModDisposeGetter>();
        try
        {
            var builtMods = new List<Fallout4Mod>();
            var registered = new List<LoadOrderEntry>();
            var opened = new Dictionary<PluginAddress, PluginContent>();
            var perPlugin = new List<(PluginAddress Key, int Slot, List<(IMajorRecordGetter Record, string RecordType)> Records)>();

            for (var slot = 0; slot < _plugins.Count; slot++)
            {
                var (name, configure, origin) = _plugins[slot];
                var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
                configure(mod, builtMods.AsReadOnly());
                builtMods.Add(mod);

                // The round trip Mutagen's own master computation needs: a bare in-memory FormLink
                // carries no master until a real write derives one from the object graph.
                var scratchPath = Path.Combine(scratch.Path, name);
                mod.WriteToBinary(scratchPath);
                var overlay = ModFactory.ImportGetter(new ModPath(ModKey.FromFileName(name), scratchPath), release);
                overlays.Add(overlay);
                var written = (IFallout4ModGetter)overlay;

                var key = new PluginAddress(name, origin);
                var masters = written.ModHeader.MasterReferences.Select(m => m.Master.FileName.String).ToList();
                var records = written.EnumerateMajorRecords()
                    .Select(r => (Record: r, RecordType: RecordTableName.Of(r.GetType(), schemas)))
                    .Where(t => t.RecordType.Length > 0)
                    .ToList();

                opened[key] = new PluginContent(
                    written.IsSmallMaster, IsMaster: masters.Count == 0 && records.Count > 0, IsBlueprint: false, masters, records.Count, IsMedium: false);
                registered.Add(new LoadOrderEntry(name, name, origin, slot, Enabled: true, Winning: true));
                perPlugin.Add((key, slot, records));
            }

            // A link's check reads only its target's record type, which every copy of a FormKey shares.
            var recordTypes = perPlugin.SelectMany(p => p.Records)
                .GroupBy(r => r.Record.FormKey.ToString(), StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First().RecordType, StringComparer.Ordinal);
            RecordLookupEntry? Resolve(string formKey) =>
                recordTypes.TryGetValue(formKey, out var recordType) ? new RecordLookupEntry(recordType, null) : null;

            var rows = perPlugin
                .SelectMany(p => p.Records.Select(r => new FakeRow(RealDocuments.Of(r.Record, p.Key, p.Slot, release, Resolve))))
                .ToList();

            return new FakeFixtureData(release, registered, opened, rows);
        }
        finally
        {
            foreach (var overlay in overlays) overlay.Dispose();
        }
    }
}
