using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PluginHoldsTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly ContainerModPlugin.Keys _keys;
    private readonly OpenedIndex _index;

    public PluginHoldsTests()
    {
        var keys = default(ContainerModPlugin.Keys);
        _fixture = new PluginFixtureBuilder("plugin-holds")
            .WithPlugin(ContainerMod.PluginName, mod => keys = ContainerModPlugin.AddTo(mod), origin: ContainerMod.Origin)
            .BuildScattered()
            .CompiledPlugin();
        _keys = keys;
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private bool? Holds(string formKey) =>
        _index.Queries.GetPluginHolds(_fixture.Plugins.Single().Key, formKey, CancellationToken.None).Value();

    [Fact]
    public void APlugin_HoldsItsOwnRecordsAndTheChildrenItsDocumentsEmbed_AndNoOtherKey()
    {
        Assert.Equal(
            (true, true, false),
            (Holds(_keys.Cell.ToString()), Holds(_keys.TemporaryRef.ToString()), Holds($"ABCDEF:{ContainerMod.PluginName}")));
    }

    [Fact]
    public void APluginWhoseFileChangedSinceItsRead_AnswersNothing()
    {
        File.AppendAllText(_fixture.Plugins.Single().Path, "changed");

        Assert.Null(Holds(_keys.Cell.ToString()));
    }
}
