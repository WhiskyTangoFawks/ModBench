using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

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
        _fixture = Fixture();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static MiscItem Named(FormKey key, string name) => new(key, Fallout4Release.Fallout4) { EditorID = $"E{key.ID:X}", Name = name };

    private static PluginFixtureData Fixture() =>
        new PluginFixtureBuilder("medit-copy-states")
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
            })
            .WithPlugin(Inactive.Name, _ => { }, enabled: false)
            .Build();

    private static Dictionary<PluginAddress, ConflictThis?> StatesOf(OpenedIndex index, FormKey record, PluginAddress? plugin = null) =>
        index.Queries.GetCopyStates([record.ToString()], plugin).Value().Single().Copies.ToDictionary(c => c.Plugin, c => c.ConflictThis);

    [Fact]
    public void ACopyIdenticalToTheMaster_OverAModOutsideTheStack_IsIdenticalToMaster()
    {
        var states = StatesOf(_index, Item, Third);

        Assert.Equal([First, Third], states.Keys);
        Assert.Equal(ConflictThis.IdenticalToMaster, states[Third]);
    }

    [Fact]
    public void ACopyIdenticalToTheMaster_OverAModInTheStack_IsIdenticalToMasterWinsConflict_AsXEditSetsIt()
    {
        Assert.Equal(ConflictThis.IdenticalToMasterWinsConflict, StatesOf(_index, Item)[Third]);
    }

    [Fact]
    public void AGivenPlugin_IsJudgedWithItsMastersAlone()
    {
        var states = StatesOf(_index, Item, Second);

        Assert.Equal([First, Second], states.Keys);
        Assert.Equal(ConflictThis.Override, states[Second]);
    }

    [Fact]
    public void AGivenPlugin_IsJudgedWithTheMastersOfItsMasters()
    {
        var master = new PluginAddress("Master.esp", PluginOrigin.DataDirectory);
        var middle = new PluginAddress("Middle.esp", PluginOrigin.DataDirectory);
        var judged = new PluginAddress("Judged.esp", PluginOrigin.DataDirectory);
        var inMiddle = new FormKey(ModKey.FromFileName(middle.Name), 0x900);
        using var fixture = new PluginFixtureBuilder("medit-copy-states-transitive")
            .WithPlugin(First.Name, mod => mod.MiscItems.Add(Named(Item, "Item")))
            .WithPlugin(master.Name, mod => mod.MiscItems.Set(Named(Item, "Changed")))
            .WithPlugin(middle.Name, mod => mod.FormLists.Add(new FormList(mod, "Lists") { Items = [new FormLink<IFallout4MajorRecordGetter>(new FormKey(ModKey.FromFileName(master.Name), 0x900))] }))
            .WithPlugin(judged.Name, mod =>
            {
                mod.MiscItems.Set(Named(Item, "Item"));
                mod.FormLists.Add(new FormList(mod, "Lists") { Items = [new FormLink<IFallout4MajorRecordGetter>(inMiddle)] });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var states = StatesOf(index, Item, judged);

        Assert.Equal(
            [(First, ConflictThis.Master), (master, ConflictThis.ConflictLoses), (judged, ConflictThis.IdenticalToMasterWinsConflict)],
            states.Select(state => (state.Key, state.Value)));
    }

    [Fact]
    public void ASourceOnlyPlugin_IsJudgedWithTheMastersItsRecordsReference()
    {
        var edited = new PluginAddress("Edited.esp", "EditedMod");
        using var fixture = new PluginFixtureBuilder("medit-copy-states-source-only")
            .WithPlugin(First.Name, mod => mod.MiscItems.Add(Named(Item, "Item")))
            .WithPlugin(Second.Name, mod => mod.MiscItems.Set(Named(Item, "Changed")))
            .WithPlugin(edited.Name, mod => mod.MiscItems.Add(Named(new FormKey(ModKey.FromFileName(edited.Name), 0x800), "Own")), origin: edited.Origin)
            .BuildScattered();
        var entry = fixture.Plugins.Single(p => p.Key == edited);
        SourceMods.Init(entry);
        using var index = Indexes.Reconciled(fixture);
        index.Create(entry, Item.ToString(), "misc", "E800", index.BodyOf(Item.ToString(), First));

        var states = StatesOf(index, Item, edited);

        Assert.Equal([First, edited], states.Keys);
        Assert.Equal(ConflictThis.IdenticalToMaster, states[edited]);
    }

    private static readonly PluginAddress NotLocalizedCopy = new("Copy.esp", PluginOrigin.DataDirectory);

    private static PluginFixtureData ALocalizedMasterCopiedUnchangedIntoAPluginNotLocalized() =>
        new PluginFixtureBuilder("medit-copy-states-localized")
            .WithPlugin(First.Name, mod =>
            {
                mod.UsingLocalization = true;
                var master = Named(Item, "Abraxo Cleaner");
                master.Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.English, "Abraxo Cleaner"),
                    new KeyValuePair<Language, string>(Language.French, "Nettoyant Abraxo"));
                mod.MiscItems.Add(master);
            })
            .WithPlugin(NotLocalizedCopy.Name, mod => mod.MiscItems.Set(Named(Item, "Abraxo Cleaner")))
            .Build();

    [Fact]
    public void ACopyNotLocalized_HoldingTheMastersTextInTheStringsLanguage_IsIdenticalToMaster_AsXEditJudgesIt()
    {
        using var fixture = ALocalizedMasterCopiedUnchangedIntoAPluginNotLocalized();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(ConflictThis.IdenticalToMaster, StatesOf(index, Item, NotLocalizedCopy)[NotLocalizedCopy]);
    }

    [Fact]
    public void ACopyNotLocalized_HoldingTheMastersTextInTheStringsLanguage_ShowsNoConflictInTheConflictView()
    {
        using var fixture = ALocalizedMasterCopiedUnchangedIntoAPluginNotLocalized();
        using var index = Indexes.Reconciled(fixture);

        var compare = index.Queries.GetCompare(Item.ToString()).Value().Require();

        Assert.Equal(ConflictThis.IdenticalToMaster, compare.Overrides.Single(o => o.Plugin == NotLocalizedCopy.Name).ConflictThis);
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
