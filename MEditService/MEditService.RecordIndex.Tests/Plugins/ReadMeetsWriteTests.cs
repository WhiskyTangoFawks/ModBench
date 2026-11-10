using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReadMeetsWriteTests : IDisposable
{
    private const string Compared = "Compared.esp";
    private const string Arriving = "Arriving.esp";

    private readonly PluginFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly ParkingSource _source = new();
    private readonly OpenedIndex _index;
    private readonly string _comparedNpc;
    private readonly string _arrivingNpc;

    public ReadMeetsWriteTests()
    {
        string compared = "", arriving = "";
        _fixture = new PluginFixtureBuilder("read-meets-write")
            .WithPlugin(Compared, mod => compared = mod.Npcs.AddNew("ComparedNpc").FormKey.ToString())
            .WithPlugin(Arriving, mod => arriving = mod.Npcs.AddNew("ArrivingNpc").FormKey.ToString())
            .Build();
        (_comparedNpc, _arrivingNpc) = (compared, arriving);
        _index = Indexes.Open(_holder, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, [.. _fixture.Plugins.Where(plugin => plugin.Name == Compared)], GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _source.Dispose();
        _fixture.Dispose();
    }

    private PluginAddress ComparedPlugin => _fixture.Plugins.Single(plugin => plugin.Name == Compared).Key;

    [Fact]
    public async Task AReadOfSeveralQueries_AnswersFromTheIndexAsItsFirstQuerySawIt_ThoughAPluginArrivesBeforeItsLast()
    {
        _source.ParkNextTreeLookup();
        var read = Task.Run(() => _index.Queries.GetCompareRecords(
            [new RecordCopy(_comparedNpc, ComparedPlugin, DocumentText: "{}"), new RecordCopy(_arrivingNpc, ComparedPlugin)]));
        await _source.WaitUntilParkedAsync();
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        _source.Release();

        Assert.Equal(CopyMissingReason.RecordGone, Assert.Single((await read).Value().Missing).Reason);
    }
}
