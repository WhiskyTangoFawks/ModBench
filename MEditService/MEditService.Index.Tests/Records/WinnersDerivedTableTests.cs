using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0009: winning is a function of the registered load order, never a column on a
/// data row, so every move of the load order moves the winner with no document re-read.</summary>
public sealed class WinnersDerivedTableTests : IDisposable
{
    private static readonly PluginCopyKey BaseKey = new("Base.esm", "BaseMod");
    private static readonly PluginCopyKey OverKey = new("Over.esp", "OverMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;
    private readonly string _npc;

    public WinnersDerivedTableTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("winners-derived-table")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("TestNpc").FormKey, origin: BaseKey.Origin)
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == npc).DeepCopy());
            }, origin: OverKey.Origin)
            .BuildScattered();
        _npc = npc.ToString();
        _index = Indexes.Open(_holder);
        Reconcile(_fixture.Plugins);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile(IReadOnlyList<LoadOrderEntry> plugins) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4);

    private IRecordReads Reads => _index.RequireReads();

    private PluginCopyKey? WinnerOf(string formKey) => Reads.GetDocument(formKey)?.Plugin;

    [Fact]
    public void TheSweep_NamesTheLatestParticipatingPlugin_OncePerFormKey()
    {
        Assert.Equal(OverKey, WinnerOf(_npc));

        // A winner is a function of the FormKey: exactly one entry of the stack carries it.
        var stack = Reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        Assert.Single(stack.Entries, e => e.IsWinner);

        // Every plugin header wins its own FormKey, swept as an ordinary record. Still asserted,
        // because "no winner" reads as "no header exists" through Open Header's winner-only lookup.
        foreach (var plugin in new[] { BaseKey, OverKey })
        {
            var headerFk = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
            Assert.Equal(plugin, WinnerOf(headerFk));
        }

        // Re-running the sweep is idempotent: a second reconcile of the same snapshot moves nothing.
        Reconcile(_fixture.Plugins);
        Assert.Equal(OverKey, WinnerOf(_npc));
        Assert.Single((Reads.GetOverrideStack(_npc) ?? throw new InvalidOperationException()).Entries, e => e.IsWinner);
    }

    [Fact]
    public void ADisabledPlugin_WinsNothing_AndWinsAgainOnceReEnabledAndSwept()
    {
        Reconcile([.. _fixture.Plugins.Select(p => p.Name == OverKey.Name ? p with { Enabled = false } : p)]);

        // Disabled in plugins.txt: Over.esp is registered (so its rows are still visible) but out of
        // the stack, so the plugin below it holds the field.
        Assert.Equal(BaseKey, WinnerOf(_npc));
        Assert.NotNull(Reads.GetDocument(_npc, OverKey));
        Assert.DoesNotContain(Reads.GetDocuments(OverKey), d => d.IsWinner);

        Reconcile(_fixture.Plugins);

        Assert.Equal(OverKey, WinnerOf(_npc));
    }

    [Fact]
    public void AnUnregisteredPlugin_WinsNothing_EvenThoughItsRowsAreStillThere()
    {
        Reconcile([.. _fixture.Plugins.Where(p => p.Name != OverKey.Name)]);

        Assert.Equal(BaseKey, WinnerOf(_npc));
        Assert.Empty(Reads.GetDocuments(OverKey));
    }
}
