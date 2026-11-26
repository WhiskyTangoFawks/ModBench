using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class WriteReadBackTests : IDisposable
{
    private const string CompiledPlugin = "CompiledPlugin.esp";
    private const string OtherPlugin = "Other.esp";
    private const string NotCompiled = "NotCompiled.esp";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan WellInsideThePark = TimeSpan.FromSeconds(5);

    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _gate = new();
    private readonly FailingCheck _checks;
    private readonly ParkingSource _source = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _npc;
    private readonly OpenedIndex _index;

    public WriteReadBackTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("write-read-back")
            .WithPlugin(CompiledPlugin, mod => npc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey.ToString(), origin: "SourceMod")
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("OtherNpc"), origin: "OtherMod")
            .BuildScattered();
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        _npc = npc;
        SourceMods.Init(_compiledPlugin);
        _checks = new FailingCheck(_gate);
        _index = Indexes.Open(_holder, _checks, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        _compiledPlugin.HandEdit(_index.DocumentOf(_npc, _compiledPlugin.Key), "\"CompiledPluginNpc\"", "\"Written\"");
    }

    public void Dispose()
    {
        _index.Dispose();
        _gate.Dispose();
        _source.Dispose();
        _fixture.Dispose();
    }

    private Task<string?> ReadBack(CancellationToken cancel = default) =>
        _index.Queries.Hold([HandedPlugin.ReadBack(_compiledPlugin.Key)], cancel);

    private Task<string?> CheckOfTheDisk() => _index.Queries.Hold(null, CancellationToken.None);

    private async Task<Task<string?>> ReadBackParked(CancellationToken cancel = default)
    {
        _source.ParkNextTreeLookup();
        var hand = ReadBack(cancel);
        await _source.WaitUntilParkedAsync();
        return hand;
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

    private async Task AssertHeldAndWritten(Task<string?> hand)
    {
        Assert.Null(await hand.WaitAsync(Generous));
        Assert.Contains("\"Written\"", _index.Queries.GetRenderedDocument(_compiledPlugin.Key, _npc).Value()?.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadBackOfTheSourceOfAPluginTheLoadOrderNamesNoSourceOf_IsAnsweredThatItsRowsAreItsBinarys()
    {
        var other = _fixture.Plugins.Single(plugin => plugin.Name == OtherPlugin).Key;

        var unread = await _index.Queries.Hold([HandedPlugin.ReadBackSource(other)], CancellationToken.None).WaitAsync(Generous);

        Assert.Contains($"names no plugin source of {OtherPlugin}", unread, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadBackOfTheSourceOfAPluginTheLoadOrderNamesASourceOf_IsHeld()
    {
        await AssertHeldAndWritten(_index.Queries.Hold([HandedPlugin.ReadBackSource(_compiledPlugin.Key)], CancellationToken.None));
    }

    [Fact]
    public async Task AnUnnamedWriteThenANamedOne_AreAnsweredOnceTheCheckAndTheReadBackLand()
    {
        await WorkerParkedInAReconcile();
        var check = CheckOfTheDisk();
        var readBack = ReadBack();

        _gate.Release();

        Assert.Null(await check.WaitAsync(Generous));
        await AssertHeldAndWritten(readBack);
    }

    [Fact]
    public async Task AnUnnamedWriteWhoseCheckFails_IsAnsweredWithTheFailure()
    {
        _checks.FailNext();

        Assert.Contains("made to fail", await CheckOfTheDisk().WaitAsync(Generous), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReadBack_IsAnsweredOnlyOnceItsReadLands()
    {
        var hand = await ReadBackParked();

        Assert.False(hand.IsCompleted);
        _source.Release();
        await AssertHeldAndWritten(hand);
    }

    [Fact]
    public async Task AReadBackWhoseCallerCancels_EndsTheWait()
    {
        using var aborted = new CancellationTokenSource();
        var hand = await ReadBackParked(aborted.Token);

        await aborted.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => hand.WaitAsync(WellInsideThePark));
        _source.Release();
    }

    [Fact]
    public async Task AReadBackThatFails_IsAnsweredWithTheFailure()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);

        Assert.StartsWith("mEdit's record index has not read", await ReadBack().WaitAsync(Generous), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AWriteThatFollowsAFailedCheck_WaitsForItsOwnCheck()
    {
        _checks.FailNext();
        await CheckOfTheDisk().WaitAsync(Generous);

        await WorkerParkedInAReconcile();
        var check = CheckOfTheDisk();

        Assert.False(check.IsCompleted);
        _gate.Release();
        await AssertHeldAndWritten(check);
    }

    [Fact]
    public async Task AReadBack_IsNotAnsweredByAnotherWritersFailedCheck()
    {
        _checks.FailNext();
        var others = CheckOfTheDisk();

        var mine = ReadBack();

        Assert.NotNull(await others.WaitAsync(Generous));
        await AssertHeldAndWritten(mine);
    }

    [Fact]
    public async Task AReadBackThatFollowsAFailedOne_WaitsForItsOwnRead()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);
        await ReadBack().WaitAsync(Generous);
        Waits.Reached(() => !_index.Status.Validating, "the failed read back's turn ending");

        var hand = await ReadBackParked();

        Assert.False(hand.IsCompleted);
        _source.Release();
        await AssertHeldAndWritten(hand);
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
