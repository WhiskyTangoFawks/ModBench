using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using SkyrimRecords = Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Serialization;

public sealed class FormatNormalizationTests
{
    private static readonly ModKey Plugin = ModKey.FromFileName("Normalized.esp");

    private static FormLink<IFactionGetter> Faction(uint id) => new(new FormKey(Plugin, id));

    private static Npc NpcInFactions(params (uint Faction, sbyte Rank)[] placements)
    {
        var npc = new Npc(new FormKey(Plugin, 0x800), Fallout4Release.Fallout4) { EditorID = "Ranked" };
        npc.Factions.AddRange(placements.Select(placement => new RankPlacement { Faction = Faction(placement.Faction), Rank = placement.Rank }));
        npc.Keywords = [new FormLink<IKeywordGetter>(new FormKey(Plugin, 0x902)), new FormLink<IKeywordGetter>(new FormKey(Plugin, 0x901))];
        return npc;
    }

    private static T Normalized<T>(T record, GameRelease release = GameRelease.Fallout4)
        where T : class => (T)GameCodecs.For(release).NormalizeFormat((Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter)record);

    [Fact]
    public void AListTheFormatSorts_IsInItsOrder_ByEachOfItsKeysInTurn()
    {
        var normalized = Normalized(NpcInFactions((0x802, 1), (0x801, 2), (0x801, 1)));

        Assert.Equal(
            [(Faction(0x801).FormKey, 1), (Faction(0x801).FormKey, 2), (Faction(0x802).FormKey, 1)],
            normalized.Factions.Select(placement => (placement.Faction.FormKey, (int)placement.Rank)));
    }

    [Fact]
    public void AListTheFormatDoesNotSort_KeepsItsOrder()
    {
        var normalized = Normalized(NpcInFactions((0x802, 1), (0x801, 1)));

        Assert.Equal([0x902u, 0x901u], normalized.Keywords.Require().Select(keyword => keyword.FormKey.ID));
    }

    [Fact]
    public void TheRecordNormalized_IsACopy_AndTheOneGivenKeepsItsOrder()
    {
        var npc = NpcInFactions((0x802, 1), (0x801, 1));

        Assert.NotSame(npc, Normalized(npc));
        Assert.Equal([0x802u, 0x801u], npc.Factions.Select(placement => placement.Faction.FormKey.ID));
    }

    [Fact]
    public void AMemberAGamesCustomizationOmits_IsWhatAFreshObjectHolds()
    {
        var recipe = new ConstructibleObject(new FormKey(Plugin, 0x800), Fallout4Release.Fallout4) { EditorID = "Recipe" };
        recipe.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData(), Unknown1 = new MemorySlice<byte>([1, 2, 3]) });

        Assert.Equal(new ConditionFloat().Unknown1.ToArray(), Normalized(recipe).Conditions.Single().Unknown1.ToArray());
    }

    [Fact]
    public void AMemberTheWholeFormatOmits_IsWhatAFreshObjectHolds()
    {
        var perk = new SkyrimRecords.Perk(new FormKey(Plugin, 0x800), SkyrimRecords.SkyrimRelease.SkyrimSE) { EditorID = "Perk" };
        perk.Conditions.Add(new SkyrimRecords.ConditionFloat
        {
            Data = new SkyrimRecords.GetActorValueConditionData { FirstUnusedStringParameter = "stale", SecondUnusedIntParameter = 7 },
        });

        var data = (SkyrimRecords.GetActorValueConditionData)Normalized(perk, GameRelease.SkyrimSE).Conditions.Single().Data;

        Assert.Equal((null, 0), (data.FirstUnusedStringParameter, data.SecondUnusedIntParameter));
    }

    [Fact]
    public void ARecordTheFormatChangesNothingIn_IsTheRecordItself()
    {
        var keyword = new Keyword(new FormKey(Plugin, 0x800), Fallout4Release.Fallout4) { EditorID = "Plain" };

        Assert.Same(keyword, Normalized(keyword));
    }
}
