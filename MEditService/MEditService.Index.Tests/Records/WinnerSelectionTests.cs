using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class WinnerSelectionTests : IDisposable
{
    private static readonly PluginAddress BaseKey = new("Base.esm", "BaseMod");
    private static readonly PluginAddress OverKey = new("Over.esp", "OverMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly string _npc;

    public WinnerSelectionTests()
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

    private PluginAddress? WinnerOf(string formKey) =>
        _index.Records.GetRecord(formKey).Value() is { } winner ? new PluginAddress(winner.Plugin, winner.Origin) : null;

    [Fact]
    public void TheLatestParticipatingPlugin_IsTheWinner_OncePerFormKey_AndAgainAfterAReconcileOfTheSameSnapshot()
    {
        Assert.Equal(OverKey, WinnerOf(_npc));

        Assert.Single(_index.StackOf(_npc), copy => copy.IsWinner);

        static string HeaderFormKeyOf(PluginAddress plugin) => PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        PluginAddress?[] headerWinners =
            [WinnerOf(HeaderFormKeyOf(BaseKey)), WinnerOf(HeaderFormKeyOf(OverKey))];
        Assert.Equal<PluginAddress?>(
            [BaseKey, OverKey], headerWinners);

        PluginBinaries.Touch(_fixture.Plugins.Single(p => p.Name == OverKey.Name).Path);
        _index.NextSnapshot();
        Assert.Equal(OverKey, WinnerOf(_npc));
        Assert.Single(_index.StackOf(_npc), copy => copy.IsWinner);
    }

    [Fact]
    public void AnUnregisteredPlugin_WinsNothing_EvenThoughItsRowsAreStillThere()
    {
        Reconcile([.. _fixture.Plugins.Where(p => p.Name != OverKey.Name)]);

        Assert.Equal(BaseKey, WinnerOf(_npc));
        Assert.Empty(_index.ListedIn(OverKey));
    }
}
