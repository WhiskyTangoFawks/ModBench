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

/// <summary>
/// #381: the HTTP door over <see cref="ExternalChangeLoadOrderHook"/>'s crash-repair offers — thin,
/// mapping-only assertions (the same posture <c>ExternalChangeEndpointsTests</c> already
/// established for #417's own door), proving the response actually carries what the hook found
/// rather than re-deriving every hook-level scenario here.
/// </summary>
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
            SnapshotRequest(), _mod.Mirror, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

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
            SnapshotRequest(), _mod.Mirror, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        Assert.Empty(ok.Value!.CrashRepairOffers);
    }

    // #588 / ADR-0001 point 6: the second window's PUT is answered 423 Locked, naming the cause, so
    // the client can tell "another window holds this instance" from a failed reconcile (500) and
    // from its own superseded snapshot (409). The other window is a real second process.
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

        var result = LoadOrderEndpoints.PutLoadOrder(request, thisWindow, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(423, problem.StatusCode);
        Assert.Contains("another Modbench window", problem.ProblemDetails.Detail, StringComparison.Ordinal);
        Assert.Equal(LoadOrderState.None, thisWindow.Status.State);
    }
}
