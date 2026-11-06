using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReadAfterSourceWriteTests : IDisposable
{
    private const string CompiledPlugin = "CompiledPlugin.esp";
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly FakeTimeProvider _clock = new(Start);
    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _gate = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _npc;
    private readonly OpenedIndex _index;

    public ReadAfterSourceWriteTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("read-after-source-write")
            .WithPlugin(CompiledPlugin, mod => npc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey.ToString(), origin: "SourceMod")
            .BuildScattered();
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        _npc = npc;
        SourceMods.Init(_compiledPlugin);
        _index = Indexes.Open(_holder, _gate, timeProvider: _clock);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        _compiledPlugin.HandEdit(_index.DocumentOf(_npc, _compiledPlugin.Key), "\"CompiledPluginNpc\"", "\"Written\"");
        _holder.SourceWritten();
    }

    public void Dispose()
    {
        _index.Dispose();
        _gate.Dispose();
        _fixture.Dispose();
    }

    private Task<Answer<RenderedDocument?, IndexRefused>> Read() =>
        Task.Run(() => _index.Queries.GetRenderedDocument(_compiledPlugin.Key, _npc));

    [Fact]
    public async Task AReadAfterASourceWrite_AnswersOnceTheNextCheckOfTheDiskEnds()
    {
        var read = Read();
        var first = await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(500)));

        _index.SignalChange();

        Assert.NotSame(read, first);
        Assert.Contains("\"Written\"", (await read.WaitAsync(Generous)).Value()?.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WaitsPastALoadOrderThatArrives()
    {
        var read = Read();

        _index.Receive(_holder, SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, NotCompiledPlugin()]));
        var first = await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(500)));

        Assert.NotSame(read, first);
        _index.SignalChange();
        Assert.Contains("\"Written\"", (await read.WaitAsync(Generous)).Value()?.Text, StringComparison.Ordinal);
    }

    private const string NotCompiled = "NotCompiled.esp";

    private LoadOrderEntry NotCompiledPlugin()
    {
        var path = Path.Combine(_fixture.DataFolder, NotCompiled);
        PluginBinaries.Rewrite(path, mod => mod.Npcs.AddNew("NotCompiledNpc"));
        return new LoadOrderEntry(NotCompiled, path, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true);
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WithNoCheckAfterIt_IsRefusedOnceItsWaitExpires_NamingWhy()
    {
        var read = Read();

        await _clock.AdvancingUntil(read, TimeSpan.FromMinutes(2));

        var refused = (await read.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("no change was signalled after the write", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("its check of the disk did not finish", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WhoseCheckIsSignalledButUnfinished_IsRefusedOnceItsWaitExpires_NamingTheCheck()
    {
        var read = Read();
        _gate.ParkNextOpenOf(NotCompiled);
        _holder.Apply(SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, NotCompiledPlugin()]));
        await _gate.WaitUntilParkedAsync();
        _index.SignalChange();

        await _clock.AdvancingUntil(read, TimeSpan.FromMinutes(2));

        var refused = (await read.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its check of the disk did not finish", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("no change was signalled", refused.Message, StringComparison.Ordinal);
        _gate.Release();
    }

    [Fact]
    public async Task ANameResolvedAfterASourceWrite_IsResolvedAgainstTheLoadOrderHeldAtTheNextCheck()
    {
        var resolved = Task.Run(() => _index.Queries.ResolveNames([new NameQuery(CompiledPlugin, null)]));
        await Task.Delay(TimeSpan.FromMilliseconds(500));

        _holder.Apply(SnapshotPlugins.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, []));
        _index.SignalChange();

        var refused = (await resolved.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Contains("Nothing is named", refused.Message, StringComparison.Ordinal);
    }
}
