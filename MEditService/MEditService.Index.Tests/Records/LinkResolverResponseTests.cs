using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class LinkResolverResponseTests : IDisposable
{
    private const string PluginName = "Fixture.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("link-resolver-response")
        .WithPlugin(PluginName, mod =>
        {
            mod.Races.AddNew("Before");
            mod.Npcs.AddNew("Asker");
        }, origin: "FixtureMod")
        .BuildScattered();
    private readonly Indexer _index;

    public LinkResolverResponseTests() => _index = Indexes.Reconciled(_fixture);

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private string FormKeyOf(string recordType) =>
        _index.RequireReads().GetDocuments(_fixture.Plugins.Single().KeyOf()).Single(d => d.RecordType == recordType).FormKey;

    private void RenameTheRace()
    {
        var path = _fixture.Plugins.Single().Path;
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Races.AddNew("After");
        mod.Npcs.AddNew("Asker");
        mod.WriteToBinary(path);
        PluginBinaries.Touch(path);
        Assert.True(_index.Revalidate());
    }

    [Fact]
    public void AResolverAnswersWhatItFirstAnswered_AfterTheIndexMovesOn()
    {
        var race = FormKeyOf("race");
        var resolve = _index.RequireReads().LinkResolver(FormKeyOf("npc_"));
        Assert.Equal("Before", resolve(race)?.EditorId);

        RenameTheRace();

        Assert.Equal("Before", resolve(race)?.EditorId);
    }

    [Fact]
    public void AResolverAskedAfterTheIndexMovesOn_AnswersTheNewRow()
    {
        var race = FormKeyOf("race");
        var asker = FormKeyOf("npc_");
        RenameTheRace();

        var resolve = _index.RequireReads().LinkResolver(asker);

        Assert.Equal("After", resolve(race)?.EditorId);
    }
}
