using MEditService.Codec.Serialization;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class WriteMemoryTests : IDisposable
{
    private const string Large = "Large.esm";
    private const int LargeRecords = 400_000;
    private const string MemoryLimit = "24MB";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _winner;
    private readonly string _npc;

    public WriteMemoryTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("write-memory")
            .WithPlugin(Large, origin: "LargeMod")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("TestNpc").FormKey, origin: "BaseMod")
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.Single().DeepCopy());
            }, origin: "WinnerMod")
            .BuildScattered();
        _winner = _fixture.Plugins.Single(p => p.Name == "Winner.esp");
        SourceMods.Init(_winner);
        _npc = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<PluginDocument> Items() => Enumerable.Range(0, LargeRecords).Select(i =>
    {
        var formKey = $"{0x800 + i:X6}:{Large}";
        return new PluginDocument("misc", formKey, $$"""{"FormKey": "{{formKey}}"}""");
    });

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_InMemoryTheWholeIndexesWinnersOutgrow()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Large, Items)));
        IndexFiles.LimitMemory(_fixture.InstanceRoot, MemoryLimit);

        index.Delete(_winner, index.DocumentOf(_npc, _winner.Key));

        Assert.Equal([("Base.esm", true)], index.StackOf(_npc).Select(copy => (copy.Plugin, copy.IsWinner)));
    }

    [Fact]
    public void CreatingAnOverride_MakesItTheWinner_InMemoryTheWholeIndexesWinnersOutgrow()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Large, Items)));
        var body = index.BodyOf(_npc, _winner.Key);
        index.Delete(_winner, index.DocumentOf(_npc, _winner.Key));
        IndexFiles.LimitMemory(_fixture.InstanceRoot, MemoryLimit);

        index.Create(_winner, _npc, "npc_", "TestNpc", body);

        Assert.Equal([("Base.esm", false), ("Winner.esp", true)], index.StackOf(_npc).Select(copy => (copy.Plugin, copy.IsWinner)));
    }
}
