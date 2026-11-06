using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class CopyStatesTests : IDisposable
{
    private static readonly PluginAddress First = new("A.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress Second = new("B.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress Third = new("C.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress Inactive = new("Off.esp", PluginOrigin.DataDirectory);
    private static readonly FormKey Item = new(ModKey.FromFileName(First.Name), 0x800);
    private static readonly FormKey OtherItem = new(ModKey.FromFileName(First.Name), 0x801);

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;

    public CopyStatesTests()
    {
        _fixture = Fixture("medit-copy-states", thirdListsSecondAsMaster: false);
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static MiscItem Named(FormKey key, string name) => new(key, Fallout4Release.Fallout4) { EditorID = $"E{key.ID:X}", Name = name };

    private static PluginFixtureData Fixture(string name, bool thirdListsSecondAsMaster) =>
        new PluginFixtureBuilder(name)
            .WithPlugin(First.Name, mod =>
            {
                mod.MiscItems.Add(Named(Item, "Item"));
                mod.MiscItems.Add(Named(OtherItem, "Other"));
            })
            .WithPlugin(Second.Name, mod =>
            {
                mod.MiscItems.Set(Named(Item, "Changed"));
                mod.MiscItems.Set(Named(OtherItem, "Other"));
            })
            .WithPlugin(Third.Name, mod =>
            {
                mod.MiscItems.Set(Named(Item, "Item"));
                if (thirdListsSecondAsMaster)
                    mod.FormLists.Add(new FormList(mod, "Lists") { Items = [new FormLink<IFallout4MajorRecordGetter>(new FormKey(ModKey.FromFileName(Second.Name), 0x900))] });
            })
            .WithPlugin(Inactive.Name, _ => { }, enabled: false)
            .Build();

    private static Dictionary<PluginAddress, ConflictThis> StatesOf(OpenedIndex index, FormKey record, PluginAddress? plugin = null) =>
        index.Queries.GetCopyStates([record.ToString()], plugin).Value().Single().Copies.ToDictionary(c => c.Plugin, c => c.ConflictThis);

    [Fact]
    public void ACopyIdenticalToTheMaster_OverAModOutsideItsMasters_IsIdenticalToMaster()
    {
        Assert.Equal(ConflictThis.IdenticalToMaster, StatesOf(_index, Item)[Third]);
    }

    [Fact]
    public void ACopyIdenticalToTheMaster_OverOneOfItsMasters_IsIdenticalToMasterWinsConflict()
    {
        using var fixture = Fixture("medit-copy-states-revert", thirdListsSecondAsMaster: true);
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(ConflictThis.IdenticalToMasterWinsConflict, StatesOf(index, Item)[Third]);
    }

    [Fact]
    public void AGivenPlugin_IsJudgedWithItsMastersAlone()
    {
        var states = StatesOf(_index, Item, Second);

        Assert.Equal([First, Second], states.Keys);
        Assert.Equal(ConflictThis.Override, states[Second]);
    }

    [Fact]
    public void WithNoPlugin_EveryActivePluginHoldingTheRecordIsJudged()
    {
        Assert.Equal([First, Second, Third], StatesOf(_index, Item).Keys);
    }

    [Fact]
    public void ManyRecordsInOneCall_AreAnsweredEachAsItIsAlone()
    {
        var answer = _index.Queries.GetCopyStates([Item.ToString(), OtherItem.ToString()], plugin: null).Value();

        Assert.Equal([Item.ToString(), OtherItem.ToString()], answer.Select(r => r.FormKey));
        Assert.Equal(StatesOf(_index, Item), answer[0].Copies.ToDictionary(c => c.Plugin, c => c.ConflictThis));
        Assert.Equal(StatesOf(_index, OtherItem), answer[1].Copies.ToDictionary(c => c.Plugin, c => c.ConflictThis));
    }

    [Fact]
    public void APluginNotActive_IsRefused_ForItHasNoMastersInTheLoadOrder()
    {
        var refused = _index.Queries.GetCopyStates([Item.ToString()], Inactive).Refused();

        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
    }
}
