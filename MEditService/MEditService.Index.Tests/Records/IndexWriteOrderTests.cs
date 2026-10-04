using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class IndexWriteOrderTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("index-write-order")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
        .BuildScattered();
    private readonly GatedPluginAdapter _adapter = new();
    private readonly Indexer _index;

    public IndexWriteOrderTests() => _index = Indexes.Reconciled(_fixture, adapter: _adapter);

    public void Dispose()
    {
        _index.Dispose();
        _adapter.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private async Task<Task> ARevalidationParkedMidWrite()
    {
        PluginBinaries.Touch(Plugin.Path);
        _adapter.ParkNextOpenOf(PluginName);
        var revalidation = Task.Run(() => _index.Revalidate());
        await _adapter.WaitUntilParkedAsync();
        return revalidation;
    }

    [Fact]
    public async Task AFilterSetWhileAReDerivationIsInFlight_TakesEffectOnlyAfterItLands()
    {
        var revalidation = await ARevalidationParkedMidWrite();

        var filter = Task.Run(() => _index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql"));

        Assert.NotSame(filter, await Task.WhenAny(filter, Task.Delay(TimeSpan.FromMilliseconds(500))));
        _adapter.Release();
        await Task.WhenAll(revalidation, filter).WaitAsync(Patience);
        Assert.Equal("filter.sql", _index.ActiveFilter?.Source);
    }

    [Fact]
    public async Task ARecordListing_IsServedWhileAReDerivationIsInFlight()
    {
        var revalidation = await ARevalidationParkedMidWrite();

        var listing = Task.Run(() => _index.RequireReads().GetDocuments(Plugin.KeyOf()));

        Assert.NotEmpty(await listing.WaitAsync(Patience));
        _adapter.Release();
        await revalidation.WaitAsync(Patience);
    }
}
