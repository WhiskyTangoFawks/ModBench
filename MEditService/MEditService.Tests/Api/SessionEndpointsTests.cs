using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Tests.Edits;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>
/// #381: the HTTP door over <see cref="ExternalChangeSessionHook"/>'s crash-repair offers — thin,
/// mapping-only assertions (the same posture <c>ExternalChangeEndpointsTests</c> already
/// established for #417's own door), proving the response actually carries what the hook found
/// rather than re-deriving every hook-level scenario here.
/// </summary>
public sealed class SessionEndpointsTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private SessionLoadExplicitRequest ReloadRequest() => new(
        [new ExplicitPlugin(TrackedModFixture.PluginName,
            System.IO.Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName),
            TrackedModFixture.ModFolderOrigin, true)],
        _mod.GameDirectory, "Fallout4");

    [Fact]
    public void LoadExplicitSession_ReportsACrashRepairOffer_WhenATrackedPluginHasAPendingJournalMarker()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [TrackedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between ledger and binary write")));

        var result = SessionEndpoints.LoadExplicitSession(
            ReloadRequest(), _mod.Sessions, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<SessionLoadResponse>>(result);
        var offer = Assert.Single(ok.Value!.CrashRepairOffers);
        Assert.Equal(TrackedModFixture.PluginName, offer.Plugin);
        Assert.Equal(TrackedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
    }

    [Fact]
    public void LoadExplicitSession_ReportsNoCrashRepairOffers_WhenNothingIsPending()
    {
        var result = SessionEndpoints.LoadExplicitSession(
            ReloadRequest(), _mod.Sessions, new ExternalChangeWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<SessionLoadResponse>>(result);
        Assert.Empty(ok.Value!.CrashRepairOffers);
    }
}
