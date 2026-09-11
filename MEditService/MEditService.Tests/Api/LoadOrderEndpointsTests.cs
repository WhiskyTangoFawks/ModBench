using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
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
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private LoadOrderRequest SnapshotRequest() => new(
        [new LoadOrderPlugin(IndexedModFixture.PluginName,
            System.IO.Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName),
            IndexedModFixture.ModFolderOrigin, 0, true, true)],
        _mod.GameDirectory, _mod.InstanceRoot, "Fallout4");

    // The kernel and the index must agree once the request returns: a snapshot the index never
    // registered must not be left advertised as the current load order.
    [Fact]
    public void PutLoadOrder_RestoresThePreviousSnapshot_WhenTheReconcileFails()
    {
        var holder = new LoadOrderHolder();
        var previous = new LoadOrder(_mod.GameDirectory, _mod.InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of([]));
        holder.Apply(previous);

        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), new IndexProjector(holder, MutagenPluginAdapter.Instance, new RefusingIndexFactory()), holder,
            new ModFolderWatcher(), NullLoggerFactory.Instance);

        Assert.Equal(500, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Equal(previous, holder.Current);
    }

    // Two plugins, parked before the first: a create that cancelled this reconcile would be caught
    // by the token check the second plugin makes, and the endpoint's revert then drops the created
    // copy from the kernel.
    [Fact]
    public async Task CreatePlugin_DuringAnInFlightReconcile_NeitherWaitsForItNorCancelsIt()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("create-during-reconcile")
            .WithPlugin("A.esp").WithPlugin("B.esp").Build();
        var reflector = SharedSchemaReflector.Instance;
        using var factory = new GatedIndexRepositoryFactory(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)), gateBefore: "A.esp");
        using var index = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        var put = Task.Run(() => LoadOrderEndpoints.PutLoadOrder(
            Request(data), index, holder, new ModFolderWatcher(), NullLoggerFactory.Instance));
        await factory.WaitUntilParkedAsync();

        var create = Task.Run(() => PluginEndpoints.CreatePlugin(
            new CreatePluginRequest("Interleaved.esp", Path.Combine(data.DataFolder, "InterleavedMod"), "InterleavedMod"),
            index, holder, TestEditService.PluginCreateHandler(holder), NullLoggerFactory.Instance));
        var created = await create.WaitAsync(TimeSpan.FromSeconds(10));
        factory.Release();

        Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(created);
        Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(await put);
        Assert.NotNull(holder.Current.Copy(new PluginKey("Interleaved.esp", "InterleavedMod")));
        Assert.Contains(holder.Current.Copies, c => c.Name == "A.esp");
    }

    private static LoadOrderRequest Request(PluginFixtureData data) => new(
        [.. data.Plugins.Select(p => new LoadOrderPlugin(p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning))],
        data.DataFolder, data.InstanceRoot, "Fallout4");

    [Fact]
    public void PutLoadOrder_ReportsACrashRepairOffer_WhenATrackedPluginHasAnUnfinishedJournalMarker()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [IndexedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));

        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), _mod.Index, new LoadOrderHolder(), new ModFolderWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        var offer = Assert.Single(ok.Value!.CrashRepairOffers);
        Assert.Equal(IndexedModFixture.PluginName, offer.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
    }

    [Fact]
    public void PutLoadOrder_ReportsNoCrashRepairOffers_WhenNothingIsUnanswered()
    {
        var result = LoadOrderEndpoints.PutLoadOrder(
            SnapshotRequest(), _mod.Index, new LoadOrderHolder(), new ModFolderWatcher(), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        Assert.Empty(ok.Value!.CrashRepairOffers);
    }

    // ADR-0001 point 6: 423 names the cause, so a client can tell "another window holds this
    // instance" from a failed reconcile (500) and from a superseded snapshot (409).
    [ForeignIndexHolderFact]
    public void PutLoadOrder_Answers423NamingTheOtherWindow_WhenAnotherProcessHoldsTheInstance()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("second-window-put").WithPlugin("A.esp").Build();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFile.For(data.InstanceRoot));
        var request = new LoadOrderRequest(
            data.Plugins.Select(p => new LoadOrderPlugin(p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning)).ToList(),
            data.DataFolder, data.InstanceRoot, "Fallout4");
        var reflector = SharedSchemaReflector.Instance;
        using var thisWindow = new IndexProjector(holder, MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));

        var result = LoadOrderEndpoints.PutLoadOrder(request, thisWindow, new LoadOrderHolder(), new ModFolderWatcher(), NullLoggerFactory.Instance);

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
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("second-window-rebuild").WithPlugin("A.esp").Build();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFile.For(data.InstanceRoot));
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var thisWindow = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        var request = new RebuildIndexRequest(data.InstanceRoot, "Fallout4");

        var result = LoadOrderEndpoints.PostRebuildIndex(request, thisWindow, NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(423, problem.StatusCode);
        Assert.Contains("another Modbench window", problem.ProblemDetails.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void PostRebuildIndex_Answers204_WhenNothingHoldsTheInstance()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("rebuild-ok").WithPlugin("A.esp").Build();
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var index = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        var request = new RebuildIndexRequest(data.InstanceRoot, "Fallout4");

        var result = LoadOrderEndpoints.PostRebuildIndex(request, index, NullLoggerFactory.Instance);

        Assert.IsAssignableFrom<NoContent>(result);
    }

    // No load order is held here on purpose: Mod Management asks this while reconciling the
    // plugins.txt a PUT is built from, so it must answer from the game directory alone.
    [Fact]
    public void GetImplicitMasters_AnswersTheForcedNames_WithNoLoadOrderHeld()
    {
        using var data = new PluginFixtureBuilder("implicit-masters-api")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();

        var result = LoadOrderEndpoints.GetImplicitMasters(data.DataFolder, "Fallout4");

        var ok = Assert.IsAssignableFrom<Ok<IReadOnlyList<string>>>(result);
        Assert.Equal(["Fallout4.esm"], ok.Value);
    }

    [Fact]
    public void GetImplicitMasters_Answers400_ForAnAbsentGameDirectory()
    {
        var result = LoadOrderEndpoints.GetImplicitMasters(
            Path.Combine(Path.GetTempPath(), $"no-such-data-{Guid.NewGuid():N}"), "Fallout4");

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
    }

    [Fact]
    public void GetImplicitMasters_Answers400_ForAnUnknownGameRelease()
    {
        using var data = new PluginFixtureBuilder("implicit-masters-release").WithPlugin("A.esp").Build();

        var result = LoadOrderEndpoints.GetImplicitMasters(data.DataFolder, "Morrowind");

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
    }
}
