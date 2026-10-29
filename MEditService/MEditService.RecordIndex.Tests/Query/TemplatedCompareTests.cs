using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class TemplatedCompareTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly FormKey _npcKey;
    private readonly FormKey _templateKey;

    public TemplatedCompareTests()
    {
        Npc? npc = null;
        Npc? template = null;
        _fixture = new PluginFixtureBuilder("medit-templated-compare")
            .WithPlugin("Base.esm", mod =>
            {
                template = mod.Npcs.AddNew("EncRaider01");
                npc = mod.Npcs.AddNew("RaiderTemplated");
                npc.UseTemplateActors = Npc.TemplateActorType.Traits;
                npc.DefaultTemplate.SetTo(template.FormKey);
            })
            .WithPlugin("Untemplated.esp", mod =>
            {
                var copy = npc.Require().DeepCopy();
                copy.UseTemplateActors = 0;
                mod.Npcs.Add(copy);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_npcKey, _templateKey) = (npc.Require().FormKey, template.Require().FormKey);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private CompareOverride Column(string plugin) =>
        (_index.Queries.GetCompare(_npcKey.ToString()).Value() ?? throw new InvalidOperationException($"Expected {_npcKey} to compare."))
            .Overrides.Single(o => o.Plugin == plugin);

    [Fact]
    public void ACopysTemplatedField_ComesWithItsFlagAndTheTemplateAsAReferenceReads()
    {
        var race = Column("Base.esm").Templated.Require()["Race"];

        Assert.Equal(("Traits", _templateKey.ToString(), "EncRaider01"), (race.Flag, race.Template, race.Resolution.EditorId));
    }

    [Fact]
    public void ACopyThatClearsTheFlag_HasNoTemplatedField()
    {
        Assert.Null(Column("Untemplated.esp").Templated);
    }
}
