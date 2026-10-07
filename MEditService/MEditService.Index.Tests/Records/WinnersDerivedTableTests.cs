using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class WinnersDerivedTableTests : IDisposable
{
    private static readonly PluginAddress BaseKey = new("Base.esm", "BaseMod");
    private static readonly PluginAddress OverKey = new("Over.esp", "OverMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
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

    private PluginAddress? WinnerOf(string formKey) => Reads.GetDocument(formKey)?.Plugin;

    [Fact]
    public void TheSweep_NamesTheLatestParticipatingPlugin_OncePerFormKey_AndAgainAfterAReconcileOfTheSameSnapshot()
    {
        Assert.Equal(OverKey, WinnerOf(_npc));

        var stack = Reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        Assert.Single(stack.Entries, e => e.IsWinner);

        static string HeaderFormKeyOf(PluginAddress plugin) => PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        PluginAddress?[] headerWinnersAssertedBecauseNoWinnerReadsAsNoHeaderThroughOpenHeadersWinnerOnlyLookup =
            [WinnerOf(HeaderFormKeyOf(BaseKey)), WinnerOf(HeaderFormKeyOf(OverKey))];
        Assert.Equal<PluginAddress?>(
            [BaseKey, OverKey], headerWinnersAssertedBecauseNoWinnerReadsAsNoHeaderThroughOpenHeadersWinnerOnlyLookup);

        PluginBinaries.Touch(_fixture.Plugins.Single(p => p.Name == OverKey.Name).Path);
        _index.NextSnapshot();
        Assert.Equal(OverKey, WinnerOf(_npc));
        Assert.Single((Reads.GetOverrideStack(_npc) ?? throw new InvalidOperationException()).Entries, e => e.IsWinner);
    }

    [Fact]
    public void ADisabledPlugin_WinsNothing_AndWinsAgainOnceReEnabledAndSwept()
    {
        Reconcile([.. _fixture.Plugins.Select(p => p.Name == OverKey.Name ? p with { Enabled = false } : p)]);

        Assert.Equal(BaseKey, WinnerOf(_npc));
        Assert.Null(Reads.GetDocument(_npc, OverKey));

        Reconcile(_fixture.Plugins);

        Assert.Equal(OverKey, WinnerOf(_npc));
    }

    [Fact]
    public void AnUnregisteredPlugin_WinsNothing_EvenThoughItsRowsAreStillThere()
    {
        Reconcile([.. _fixture.Plugins.Where(p => p.Name != OverKey.Name)]);

        Assert.Equal(BaseKey, WinnerOf(_npc));
        Assert.Empty(Reads.DocumentsOf(OverKey));
    }
}
