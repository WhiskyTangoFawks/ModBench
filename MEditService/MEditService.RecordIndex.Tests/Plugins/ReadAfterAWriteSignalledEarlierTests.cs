using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReadAfterAWriteSignalledEarlierTests : IDisposable
{
    private const string CompiledPlugin = "CompiledPlugin.esp";
    private const string LatePlugin = "Late.esp";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _gate = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _npc;
    private readonly OpenedIndex _index;

    public ReadAfterAWriteSignalledEarlierTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("read-after-a-write-signalled-earlier")
            .WithPlugin(CompiledPlugin, mod => npc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey.ToString(), origin: "SourceMod")
            .WithPlugin(LatePlugin, mod => mod.Npcs.AddNew("LateNpc"), origin: "NonSourceMod")
            .BuildScattered();
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        _npc = npc;
        SourceMods.Init(_compiledPlugin);
        _index = Indexes.Open(_holder, _gate, timeProvider: _clock);
        _index.Reconcile(_holder, _fixture.DataFolder, [_compiledPlugin], GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _gate.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WaitsPastACheckSignalledBeforeTheWrite_ThoughThatCheckBeganAfterIt()
    {
        var document = _index.DocumentOf(_npc, _compiledPlugin.Key);
        _gate.ParkNextOpenOf(LatePlugin);
        _holder.Apply(SnapshotPlugins.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, _fixture.Plugins));
        await _gate.WaitUntilParkedAsync();
        _index.SignalChange();
        _compiledPlugin.HandEdit(document, "\"CompiledPluginNpc\"", "\"Written\"");
        _holder.SourceWritten();

        var read = Task.Run(() => _index.Queries.GetRenderedDocument(_compiledPlugin.Key, _npc));
        _gate.Release();
        var first = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(1)));

        Assert.NotSame(read, first);
        _index.SignalChange();
        Assert.Contains("\"Written\"", (await read.WaitAsync(Generous)).Value()?.Text, StringComparison.Ordinal);
    }
}
