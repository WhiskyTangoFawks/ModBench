using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
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
    private const string OtherPlugin = "Other.esp";
    private const string NotCompiled = "NotCompiled.esp";
    private static readonly PluginAddress NotInTheLoadOrder = new("Created.esp", "CreatedMod");
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan WellInsideThePark = TimeSpan.FromSeconds(5);

    private readonly FakeTimeProvider _clock = new(Start);
    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _gate = new();
    private readonly FailingCheck _checks;
    private readonly ParkingSource _source = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _npc;
    private readonly OpenedIndex _index;

    public ReadAfterSourceWriteTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("read-after-source-write")
            .WithPlugin(CompiledPlugin, mod => npc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey.ToString(), origin: "SourceMod")
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("OtherNpc"), origin: "OtherMod")
            .BuildScattered();
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        _npc = npc;
        SourceMods.Init(_compiledPlugin);
        _checks = new FailingCheck(_gate);
        _index = Indexes.Open(_holder, _checks, timeProvider: _clock, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Waits.Reached(() => _index.Status is { State: LoadOrderState.Ready, Validating: false }, "the index at rest");
        _compiledPlugin.HandEdit(_index.DocumentOf(_npc, _compiledPlugin.Key), "\"CompiledPluginNpc\"", "\"Written\"");
    }

    public void Dispose()
    {
        _index.Dispose();
        _gate.Dispose();
        _source.Dispose();
        _fixture.Dispose();
    }

    private void Written() => _holder.SourceWritten([_compiledPlugin.Key]);

    private async Task WrittenWithItsReReadParked()
    {
        _source.ParkNextTreeLookup();
        Written();
        await _source.WaitUntilParkedAsync();
    }

    private LoadOrderEntry NotCompiledEntry()
    {
        var path = Path.Combine(_fixture.DataFolder, NotCompiled);
        PluginBinaries.Rewrite(path, mod => mod.Npcs.AddNew("NotCompiledNpc"));
        return new LoadOrderEntry(NotCompiled, path, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true);
    }

    private async Task WorkerParkedInAReconcile()
    {
        _gate.ParkNextOpenOf(NotCompiled);
        _holder.Apply(SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, NotCompiledEntry()]));
        await _gate.WaitUntilParkedAsync();
    }

    private Task<Answer<RenderedDocument?, IndexRefused>> Read(CancellationToken cancel = default) =>
        _index.Queries.GetRenderedDocument(_compiledPlugin.Key, _npc, cancel);

    private static void AssertWritten(Answer<RenderedDocument?, IndexRefused> answer) =>
        Assert.Contains("\"Written\"", answer.Value()?.Text, StringComparison.Ordinal);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AReadAfterASourceWrite_AnswersWhatItWrote_WithNoChangeSignalled(bool writeNamesItsPlugin)
    {
        _holder.SourceWritten(writeNamesItsPlugin ? [_compiledPlugin.Key] : null);

        AssertWritten(await Read().WaitAsync(Generous));
    }

    [Fact]
    public async Task AReadAfterAnUnnamedWriteAndThenANamedOne_AnswersOnceTheCheckAndTheReReadLand()
    {
        await WorkerParkedInAReconcile();
        _holder.SourceWritten(null);
        Written();
        var read = Read();

        _gate.Release();

        AssertWritten(await read.WaitAsync(Generous));
    }

    [Fact]
    public async Task AReadAfterAnUnnamedWriteAndThenANamedOne_WhoseCheckFails_IsRefusedAtOnce_NamingTheFailedCheck()
    {
        await WorkerParkedInAReconcile();
        _checks.FailNext();
        _holder.SourceWritten(null);
        Written();
        var read = Read();

        _gate.Release();

        var refused = (await read.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its check of the disk failed", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WaitsPastAReReadOfAnotherPlugin()
    {
        _holder.SourceWritten([NotInTheLoadOrder]);
        var read = Read();

        _index.SignalChange([_fixture.Plugins.Single(p => p.Name == OtherPlugin).Key]);
        Waits.Reached(() => !_index.Status.Validating, "the other plugin's re-read");

        Assert.NotSame(read, await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(500))));
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WaitsPastALoadOrderThatArrives()
    {
        _holder.SourceWritten([NotInTheLoadOrder]);
        var read = Read();

        _index.Receive(_holder, SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, NotCompiledEntry()]));

        Assert.NotSame(read, await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(500))));
    }

    [Fact]
    public async Task AReadWaitingOnTheReadOfASourceWrite_HoldsNoThread()
    {
        await WrittenWithItsReReadParked();

        var read = Read();

        Assert.False(read.IsCompleted);
        _source.Release();
        AssertWritten(await read.WaitAsync(Generous));
    }

    [Fact]
    public async Task AReadWaitingOnTheReadOfASourceWrite_EndsWhenItsCallerCancels()
    {
        await WrittenWithItsReReadParked();
        using var aborted = new CancellationTokenSource();
        var read = Read(aborted.Token);

        await aborted.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read.WaitAsync(WellInsideThePark));
        _source.Release();
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WhoseReReadIsUnfinished_IsRefusedOnceItsWaitExpires_NamingTheReRead()
    {
        await WrittenWithItsReReadParked();
        var read = Read();

        await _clock.AdvancingUntil(read, TimeSpan.FromMinutes(2));

        var refused = (await read.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its re-read of the plugins written did not finish", refused.Message, StringComparison.Ordinal);
        _source.Release();
    }

    [Fact]
    public async Task AReadAfterASourceWrite_WhoseReReadFails_IsRefusedAtOnce_NamingTheFailedReRead()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);
        Written();

        var refused = (await Read().WaitAsync(Generous)).Refused();

        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its re-read of the plugins written failed", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadAfterASourceWriteNamingNoPlugin_WhoseCheckFails_IsRefusedAtOnce_NamingTheFailedCheck()
    {
        _checks.FailNext();
        _holder.SourceWritten(null);

        var refused = (await Read().WaitAsync(Generous)).Refused();

        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its check of the disk failed", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadAfterAWriteThatFollowsAFailedCheck_WaitsForItsOwnCheck()
    {
        _checks.FailNext();
        _holder.SourceWritten(null);
        await Read().WaitAsync(Generous);

        await WorkerParkedInAReconcile();
        _holder.SourceWritten(null);
        var read = Read();

        Assert.False(read.IsCompleted);
        _gate.Release();
        AssertWritten(await read.WaitAsync(Generous));
    }

    [Fact]
    public async Task AReadAfterAWriteThatFollowsAFailedReRead_WaitsForItsOwnReRead()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);
        Written();
        await Read().WaitAsync(Generous);
        Waits.Reached(() => !_index.Status.Validating, "the failed re-read's turn ending");

        await WrittenWithItsReReadParked();
        var read = Read();

        Assert.False(read.IsCompleted);
        _source.Release();
        AssertWritten(await read.WaitAsync(Generous));
    }

    [Fact]
    public async Task AReadAfterASourceWriteNamingNoPlugin_WhoseCheckIsUnfinished_IsRefusedOnceItsWaitExpires_NamingTheCheck()
    {
        await WorkerParkedInAReconcile();
        _holder.SourceWritten(null);
        var read = Read();

        await _clock.AdvancingUntil(read, TimeSpan.FromMinutes(2));

        var refused = (await read.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("its check of the disk did not finish", refused.Message, StringComparison.Ordinal);
        _gate.Release();
    }

    [Fact]
    public async Task AReReadASourceWriteAsks_WhileACheckAskedBeforeItWaits_StillReleasesTheRead()
    {
        await WorkerParkedInAReconcile();
        _index.SignalChange();
        Written();
        var read = Read();

        _gate.Release();

        AssertWritten(await read.WaitAsync(Generous));
    }

    [Fact]
    public async Task ANameResolvedAfterASourceWrite_IsResolvedAgainstTheLoadOrderHeldOnceTheWriteIsRead()
    {
        await WrittenWithItsReReadParked();
        var resolved = _index.Queries.ResolveNames([new NameQuery(CompiledPlugin, null)]);

        _holder.Apply(SnapshotPlugins.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, []));
        _source.Release();

        var refused = (await resolved.WaitAsync(Generous)).Refused();
        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Contains("Nothing is named", refused.Message, StringComparison.Ordinal);
    }

    private sealed class FailingCheck(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        private int _armed;

        public void FailNext() => Volatile.Write(ref _armed, 1);

        public override void KeepStateOf(IReadOnlySet<string> pluginPaths)
        {
            if (Interlocked.Exchange(ref _armed, 0) == 1) throw new InvalidOperationException("The check of the disk was made to fail.");
            base.KeepStateOf(pluginPaths);
        }
    }
}
