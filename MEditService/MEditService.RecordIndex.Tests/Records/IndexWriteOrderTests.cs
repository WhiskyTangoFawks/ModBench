using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class IndexWriteOrderTests : IDisposable
{
    private const string PluginName = "Fixture.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("index-write-order")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
        .BuildScattered();
    private readonly GatedPluginAdapter _adapter = new();
    private readonly OpenedIndex _index;

    public IndexWriteOrderTests() => _index = Indexes.Reconciled(_fixture, adapter: _adapter);

    public void Dispose()
    {
        _index.Dispose();
        _adapter.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    [Fact]
    public async Task AFilterSetWhileAReDerivationIsInFlight_TakesEffectOnlyAfterItLands()
    {
        PluginBinaries.Touch(Plugin.Path);
        _adapter.ParkNextOpenOf(PluginName);
        var revalidation = Task.Run(_index.NextCheck);
        await _adapter.WaitUntilParkedAsync();

        var filter = Task.Run(() => _index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql"));

        Assert.NotSame(filter, await Task.WhenAny(filter, Task.Delay(TimeSpan.FromMilliseconds(100))));
        _adapter.Release();
        await Task.WhenAll(revalidation, filter).WaitAsync(Waits.Patience);
        Assert.Equal("filter.sql", _index.Queries.GetFilter().Value()?.Source);
    }
}
