using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class TemplatedConflictTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly FormKey _lastTemplatedKey;
    private readonly FormKey _middleTemplatedKey;
    private readonly FormKey _factionsTemplatedKey;

    public TemplatedConflictTests()
    {
        Npc? lastTemplated = null;
        Npc? middleTemplated = null;
        Race? first = null;
        Race? second = null;
        Race? third = null;
        Npc? template = null;
        Npc? factionsTemplated = null;
        Faction? faction = null;
        _fixture = new PluginFixtureBuilder("medit-templated-conflict")
            .WithPlugin("Base.esm", mod =>
            {
                template = mod.Npcs.AddNew("Template");
                (first, second, third) = (mod.Races.AddNew("First"), mod.Races.AddNew("Second"), mod.Races.AddNew("Third"));
                lastTemplated = mod.Npcs.AddNew("LastTemplated");
                lastTemplated.Race.SetTo(first.FormKey);
                lastTemplated.VirtualMachineAdapter = new VirtualMachineAdapter { Scripts = [new ScriptEntry { Name = "Base" }] };
                middleTemplated = mod.Npcs.AddNew("MiddleTemplated");
                middleTemplated.Race.SetTo(first.FormKey);
                faction = mod.Factions.AddNew("Guild");
                factionsTemplated = mod.Npcs.AddNew("FactionsTemplated");
            })
            .WithPlugin("Middle.esp", mod =>
            {
                var copy = middleTemplated.Require().DeepCopy();
                copy.UseTemplateActors = Npc.TemplateActorType.Traits;
                copy.DefaultTemplate.SetTo(template.Require().FormKey);
                copy.Race.SetTo(second.Require().FormKey);
                mod.Npcs.Add(copy);
            })
            .WithPlugin("Top.esp", mod =>
            {
                var copy = middleTemplated.Require().DeepCopy();
                copy.Race.SetTo(third.Require().FormKey);
                mod.Npcs.Add(copy);
                var last = lastTemplated.Require().DeepCopy();
                last.UseTemplateActors = Npc.TemplateActorType.Traits | Npc.TemplateActorType.Script;
                last.DefaultTemplate.SetTo(template.Require().FormKey);
                last.Race.SetTo(second.Require().FormKey);
                last.VirtualMachineAdapter = new VirtualMachineAdapter { Scripts = [new ScriptEntry { Name = "Top" }] };
                mod.Npcs.Add(last);
                var factions = factionsTemplated.Require().DeepCopy();
                factions.UseTemplateActors = Npc.TemplateActorType.Factions;
                factions.DefaultTemplate.SetTo(template.Require().FormKey);
                factions.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(faction.Require().FormKey), Rank = 1 });
                mod.Npcs.Add(factions);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_lastTemplatedKey, _middleTemplatedKey, _factionsTemplatedKey) =
            (lastTemplated.Require().FormKey, middleTemplated.Require().FormKey, factionsTemplated.Require().FormKey);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private FieldDiff Row(FormKey record, string field = "Race") =>
        (_index.Queries.GetCompare(record.ToString()).Value() ?? throw new InvalidOperationException($"Expected {record} to compare."))
            .Diffs.Single(d => d.FieldName == field);

    [Fact]
    public void AFieldTheLastCopyTemplates_HasNoWinner_AndNoConflictColour()
    {
        var race = Row(_lastTemplatedKey);

        Assert.True(race.NoWinner);
        Assert.Empty(race.CellStates);
        Assert.Equal(ConflictAll.NoConflict, race.ConflictAll);
    }

    [Fact]
    public void AFieldAnEarlierCopyTemplates_TakesNoPartInTheComparison_AndTheLastCopyWinsIt()
    {
        var race = Row(_middleTemplatedKey);

        Assert.False(race.NoWinner);
        Assert.Equal("Top.esp", race.WinnerColumn);
        Assert.DoesNotContain("Middle.esp", race.CellStates.Keys);
        Assert.Equal(ConflictThis.Override, race.CellStates["Top.esp"]);
    }

    [Fact]
    public void TheRowsUnderATemplatedField_HaveNoWinnerEither()
    {
        var factions = Row(_factionsTemplatedKey, "Factions");

        var element = Assert.Single(factions.Children.Require());
        Assert.True(element.NoWinner);
        Assert.Empty(element.CellStates);
    }

    [Fact]
    public void TheMembersOfATemplatedStruct_HaveNoWinnerEither()
    {
        var scripts = Assert.Single(Row(_lastTemplatedKey, "VirtualMachineAdapter").Children.Require(), d => d.FieldName == "Scripts");

        Assert.True(scripts.NoWinner);
        Assert.Empty(scripts.CellStates);
    }

    [Fact]
    public void ATemplatedField_IsNoConflictInARecordComparedWithItsUntemplatedCopy_ThoughTheValuesDiffer()
    {
        var copies = new[] { "Base.esm", "Middle.esp" }
            .Select(plugin => new RecordCopy(_middleTemplatedKey.ToString(), new PluginAddress(plugin, PluginOrigin.DataDirectory)))
            .ToList();

        var race = _index.Queries.GetCompareRecords(copies).Compared().Diffs.Single(d => d.FieldName == "Race");

        Assert.Equal(ConflictAll.NoConflict, race.ConflictAll);
    }
}
