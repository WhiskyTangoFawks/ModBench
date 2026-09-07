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
