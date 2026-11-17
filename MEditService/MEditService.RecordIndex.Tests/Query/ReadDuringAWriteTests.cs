using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ReadDuringAWriteTests : IDisposable
{
    private const string Written = "B.esp";
    private static readonly TimeSpan NoWaitOnTheWrite = TimeSpan.FromSeconds(10);

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("read-during-a-write")
        .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
        .WithPlugin(Written, mod => mod.Npcs.AddNew("FromB"))
        .Build();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task ASelect_AnswersWhileAWriteHoldsTheRecordIndex()
    {
        using var adapter = new GatedPluginAdapter();
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter);
        var written = _fixture.Plugins.Single(plugin => plugin.Name == Written);
        adapter.ParkNextOpenOf(Written);
        PluginBinaries.Touch(written.Path);
        index.SignalChange([written.Key]);
        await adapter.WaitUntilParkedAsync();

        try
        {
            var selected = await Task.Run(() => index.Queries.Selected("SELECT editor_id FROM npc_ WHERE editor_id = 'FromA'")).WaitAsync(NoWaitOnTheWrite);
            Assert.Single(selected);
        }
        finally
        {
            adapter.Release();
        }
    }
}
