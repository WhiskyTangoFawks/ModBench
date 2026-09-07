using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>Thin, mapping-only assertions proving the response carries what the hook found, not a
/// re-derivation of every hook-level scenario.</summary>
public sealed class LoadOrderEndpointsTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private LoadOrderRequest SnapshotRequest() => new(
        [new LoadOrderPlugin(TrackedModFixture.PluginName,
            System.IO.Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName),
            TrackedModFixture.ModFolderOrigin, 0, true, true)],
        _mod.GameDirectory, _mod.InstanceRoot, "Fallout4");

    // The kernel and the index must agree once the request returns: a snapshot the index never
    // registered must not be left advertised as the current load order.
    [Fact]
    public void PutLoadOrder_RestoresThePreviousSnapshot_WhenTheReconcileFails()
    {
        var holder = new LoadOrderHolder();
        var previous = LoadOrder.From(_mod.GameDirectory, _mod.InstanceRoot, GameRelease.Fallout4, []);
        holder.Apply(previous);

        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), new ThrowingMirror(), holder, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        Assert.Equal(500, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Equal(previous, holder.Current);
    }

    // ADR-0041: a created plugin is a registered copy at once, so the Track that follows it in the
    // same gesture, and every later reader, find it without waiting for the next snapshot.
    [Fact]
    public async Task CreatePlugin_RegistersTheCopyInTheSharedKernel()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(LoadOrder.From(_mod.GameDirectory, _mod.InstanceRoot, GameRelease.Fallout4, []));

        var result = await PluginEndpoints.CreatePlugin(
            new CreatePluginRequest("Minted.esp", _mod.ModFolder, TrackedModFixture.ModFolderOrigin),
            _mod.Mirror, holder, new TrackService(NullLogger<TrackService>.Instance), NullLoggerFactory.Instance);

        Assert.IsAssignableFrom<Ok<PluginResponse>>(result);
        var registered = holder.Current.Copy(new PluginKey("Minted.esp", TrackedModFixture.ModFolderOrigin));
        Assert.NotNull(registered);
        Assert.Equal(Path.Combine(_mod.ModFolder, "Minted.esp"), registered.Path);
    }

    private sealed class ThrowingMirror : ILoadOrderMirror
    {
        public ILoadOrder? LoadOrder => null;
        public IRecordReads? Reads => null;
        public IRecordIndex? Index => null;
        public IndexWriteGate WriteGate { get; } = new();
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public long Sequence => 0;
        public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => throw new NotSupportedException();
        public IDisposable BeginProjection() => throw new NotSupportedException();
        public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => throw new NoLoadOrderException();
        public void Reconcile(
            string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
            string? instanceRoot = null) => throw new InvalidOperationException("the reconcile failed");
        public void Close() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name, string path, string origin) => throw new NotSupportedException();
        public Task ReindexPlugin(PluginKey key) => throw new NotSupportedException();
        public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin) => throw new NotSupportedException();
        public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys) => throw new NotSupportedException();
        public Action? LoadOrderChanged { get; set; }
        public void UnindexPlugin(PluginKey key) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
        public void ReapplyFilter() => throw new NotSupportedException();
    }

    [Fact]
    public void PutLoadOrder_ReportsACrashRepairOffer_WhenATrackedPluginHasAnUnfinishedJournalMarker()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [TrackedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));

        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), _mod.Mirror, new LoadOrderHolder(), new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        var offer = Assert.Single(ok.Value!.CrashRepairOffers);
        Assert.Equal(TrackedModFixture.PluginName, offer.Plugin);
        Assert.Equal(TrackedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
    }

    [Fact]
    public void PutLoadOrder_ReportsNoCrashRepairOffers_WhenNothingIsUnanswered()
    {
        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), _mod.Mirror, new LoadOrderHolder(), new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        Assert.Empty(ok.Value!.CrashRepairOffers);
    }

    // ADR-0001 point 6: 423 names the cause, so a client can tell "another window holds this
    // instance" from a failed reconcile (500) and from a superseded snapshot (409).
    [ForeignIndexHolderFact]
    public void PutLoadOrder_Answers423NamingTheOtherWindow_WhenAnotherProcessHoldsTheInstance()
    {
        using var data = new PluginFixtureBuilder("second-window-put").WithPlugin("A.esp").Build();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFile.For(data.InstanceRoot));
        var request = new LoadOrderRequest(
            data.Plugins.Select(p => new LoadOrderPlugin(p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning)).ToList(),
            data.DataFolder, data.InstanceRoot, "Fallout4");
        var reflector = SharedSchemaReflector.Instance;
        using var thisWindow = new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));

        var result = LoadOrderEndpoints.PutLoadOrder(request, thisWindow, new LoadOrderHolder(), new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(423, problem.StatusCode);
        Assert.Contains("another Modbench window", problem.ProblemDetails.Detail, StringComparison.Ordinal);
        Assert.Equal(LoadOrderState.None, thisWindow.Status.State);
    }

    // ADR-0046: the rebuild endpoint's own refusal, at the handler seam — mirrors PutLoadOrder's
    // 423 above.
    [ForeignIndexHolderFact]
    public void PostRebuildIndex_Answers423NamingTheOtherWindow_WhenAnotherProcessHoldsTheInstance()
    {
        using var data = new PluginFixtureBuilder("second-window-rebuild").WithPlugin("A.esp").Build();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFile.For(data.InstanceRoot));
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var thisWindow = new LoadOrderMirror(factory);
        var request = new RebuildIndexRequest(data.InstanceRoot, "Fallout4");

        var result = LoadOrderEndpoints.PostRebuildIndex(request, thisWindow, factory, NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(423, problem.StatusCode);
        Assert.Contains("another Modbench window", problem.ProblemDetails.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void PostRebuildIndex_Answers204_WhenNothingHoldsTheInstance()
    {
        using var data = new PluginFixtureBuilder("rebuild-ok").WithPlugin("A.esp").Build();
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var mirror = new LoadOrderMirror(factory);
        var request = new RebuildIndexRequest(data.InstanceRoot, "Fallout4");

        var result = LoadOrderEndpoints.PostRebuildIndex(request, mirror, factory, NullLoggerFactory.Instance);

        Assert.IsAssignableFrom<NoContent>(result);
    }
}
