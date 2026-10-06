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
    public void TheOpenedPlugins_AnswerTheSamePlugin_WhateverTheCase()
    {
        Assert.True(_index.RequireReads().OpenedPlugins.ContainsKey(OtherCase));
    }

    [Fact]
    public void AReadUnderAnotherCase_AnswersThePluginsRows()
    {
        var reads = _index.RequireReads();

        Assert.Equal(
            reads.GetDocuments(_fixture.Plugins.Single().KeyOf()).Select(d => d.FormKey).Order(),
            reads.GetDocuments(OtherCase).Select(d => d.FormKey).Order());
    }

    private string UnderAnotherCase(string editorId) =>
        _index.RequireReads().GetDocuments(_fixture.Plugins.Single().KeyOf())
            .Single(d => d.EditorId == editorId).FormKey.ToUpperInvariant();

    [Fact]
    public void APointReadUnderAnotherCase_AnswersTheRecord()
    {
        Assert.Equal("FromCased", _index.RequireReads().GetDocument(UnderAnotherCase("FromCased"))?.EditorId);
    }

    [Fact]
    public void AnOverrideStackUnderAnotherCase_HoldsThePluginsCopy()
    {
        var stack = _index.RequireReads().GetOverrideStack(UnderAnotherCase("FromCased"));

        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
    }

    [Fact]
    public void ASearchFilteredUnderAnotherCase_FindsThePluginsRecords()
    {
        var query = new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Plugin: new PluginName(OtherCase.Name), Origin: OtherCase.Origin);

        Assert.Equal(1, _index.RequireReads().Search(query).Total);
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

        Assert.Equal(1, reopened.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"])).Total);
    }
}
