using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class PluginAddressComparisonTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("plugin-address-comparison")
        .WithPlugin("Cased.esp", mod => mod.Npcs.AddNew("FromCased").Race.SetTo(mod.Races.AddNew("CasedRace")), origin: "CasedMod")
        .BuildScattered();

    private readonly OpenedIndex _index;

    public PluginAddressComparisonTests() => _index = Indexes.Reconciled(_fixture);

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress OtherCase = new("CASED.ESP", "casedmod");

    [Fact]
    public void ThePluginsRecordTypes_AnswerUnderAnotherCase()
    {
        Assert.Equal(1, _index.CountOf(OtherCase, "NPC_"));
    }

    [Fact]
    public void AListingUnderAnotherCase_AnswersThePluginsRows()
    {
        Assert.Equal(
            _index.ListedIn(_fixture.Plugins.Single().KeyOf()).Select(row => row.FormKey),
            _index.ListedIn(OtherCase).Select(row => row.FormKey));
    }

    private string UnderAnotherCase(string editorId) =>
        _index.ListedIn(_fixture.Plugins.Single().KeyOf())
            .Single(row => row.EditorId == editorId).FormKey.ToUpperInvariant();

    [Fact]
    public void APointReadUnderAnotherCase_AnswersTheRecord()
    {
        Assert.Equal("FromCased", _index.Records.GetRecord(UnderAnotherCase("FromCased")).Value()?.EditorId);
    }

    [Fact]
    public void ACopyReadUnderAnotherCase_AnswersThePluginsCopy()
    {
        Assert.Equal("FromCased", _index.CopyIn(UnderAnotherCase("FromCased"), OtherCase)?.EditorId);
    }

    [Fact]
    public void AnOverrideStackUnderAnotherCase_HoldsThePluginsCopy()
    {
        Assert.Single(_index.StackOf(UnderAnotherCase("FromCased")));
    }

    [Fact]
    public void ASearchUnderAnotherCase_FindsThePluginsRecords()
    {
        Assert.Equal(1, _index.Records.GetRecords(["npc_"], OtherCase, search: "FromCased", limit: 10, offset: 0).Value().Total);
    }

    [Fact]
    public void ASqlDoorFilterOnALinkUnderAnotherCase_MatchesTheLinkingRecord()
    {
        Assert.Equal(1, _index.Matching($"SELECT form_key FROM npc_ WHERE \"Race\" = '{UnderAnotherCase("CasedRace")}'"));
    }

    [Fact]
    public void AnIndexReopenedUnderAnotherCase_HoldsOneCopyOfItsRecord()
    {
        var entry = _fixture.Plugins.Single();
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot).Dispose();

        using var reopened = Indexes.Reconciled(_fixture.GameDirectory,
            [entry with { Name = OtherCase.Name, Origin = OtherCase.Origin }], _fixture.InstanceRoot);

        Assert.Equal(1, reopened.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Total);
    }
}
