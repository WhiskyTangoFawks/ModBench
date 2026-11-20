using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class RecordOwnersTests
{
    private static readonly PluginAddress Base = new("Base.esp", "BaseMod");
    private static readonly PluginAddress Over = new("Over.esp", "OverMod");

    private sealed record Holder(bool Active, bool Compiled);

    private static IReadOnlyList<PluginAddress> OwnersOfTheNpc(Holder @base, Holder over)
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("record-owners")
            .WithPlugin(Base.Name, mod => npc = mod.Npcs.AddNew("Shared").FormKey, enabled: @base.Active, origin: Base.Origin)
            .WithPlugin(Over.Name, (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(Base.Name) });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == Base.Name).Npcs.Single().DeepCopy());
            }, enabled: over.Active, origin: Over.Origin)
            .BuildScattered();
        if (@base.Compiled) SourceMods.Init(fixture.Plugins.Single(p => p.Name == Base.Name));
        if (over.Compiled) SourceMods.Init(fixture.Plugins.Single(p => p.Name == Over.Name));
        using var index = Indexes.Reconciled(fixture);
        return index.Queries.GetRecordOwners(npc.ToString()).Value();
    }

    [Theory]
    [InlineData(true, false, false, true, new[] { "Base.esp" })]
    [InlineData(false, true, false, false, new[] { "Base.esp" })]
    [InlineData(false, true, false, true, new[] { "Base.esp", "Over.esp" })]
    [InlineData(false, false, false, false, new string[0])]
    public void TheOwners_AreTheActiveWinner_ElseEachCompiledHolder(
        bool baseActive, bool baseCompiled, bool overActive, bool overCompiled, string[] owners)
    {
        Assert.Equal(
            owners.Select(name => name == Base.Name ? Base : Over),
            OwnersOfTheNpc(new Holder(baseActive, baseCompiled), new Holder(overActive, overCompiled)));
    }

    [Fact]
    public void OneAskOfManyRecords_AnswersTheOwnersOfEach_AndNoneOfARecordNoPluginHolds()
    {
        FormKey shared = default, alone = default;
        using var fixture = new PluginFixtureBuilder("records-owners")
            .WithPlugin(Base.Name, mod => (shared, alone) = (mod.Npcs.AddNew("Shared").FormKey, mod.Npcs.AddNew("Alone").FormKey), origin: Base.Origin)
            .WithPlugin(Over.Name, (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(Base.Name) });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == Base.Name).Npcs.First().DeepCopy());
            }, origin: Over.Origin)
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var unheld = $"000FFF:{Base.Name}";

        var owners = index.Queries.GetOwnersOfRecords([shared.ToString(), alone.ToString(), unheld]).Value();

        Assert.Equal(
            new Dictionary<string, IReadOnlyList<PluginAddress>> { [shared.ToString()] = [Over], [alone.ToString()] = [Base], [unheld] = [] },
            owners);
    }
}
