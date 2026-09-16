using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Http;
using MEditService.Http.Endpoints;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>Thin, mapping-only assertions proving the response carries what the handler found, not
/// a re-derivation of every handler-level scenario.</summary>
public sealed class LoadOrderEndpointsTests
{
    private static LoadOrderRequest Request(PluginFixtureData data) => new(
        [.. data.Plugins.Select(p => new LoadOrderPlugin(p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning))],
        data.DataFolder, data.InstanceRoot, "Fallout4");

    [Fact]
    public void PutLoadOrder_AnswersApplied_ForAValidSnapshot()
    {
        using var data = new PluginFixtureBuilder("put-load-order-applied").WithPlugin("A.esp").Build();
        var holder = new LoadOrderHolder();

        var result = LoadOrderEndpoints.PutLoadOrder(Request(data), TestEditService.PutLoadOrderHandler(holder), NullLoggerFactory.Instance);

        var ok = Assert.IsAssignableFrom<Ok<LoadOrderResponse>>(result);
        var response = ok.Value;
        Assert.NotNull(response);
        Assert.True(response.Applied);
        Assert.Contains(holder.Current.Copies, c => c.Name == "A.esp");
    }

    [Fact]
    public void PutLoadOrder_Answers400_ForAMissingGameDirectory()
    {
        var holder = new LoadOrderHolder();
        var missing = Path.Combine(Path.GetTempPath(), $"no-such-dir-{Guid.NewGuid():N}");
        var request = new LoadOrderRequest([], missing, missing, "Fallout4");

        var result = LoadOrderEndpoints.PutLoadOrder(request, TestEditService.PutLoadOrderHandler(holder), NullLoggerFactory.Instance);

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Equal(LoadOrderSnapshot.Empty, holder.Current);
    }

    [Fact]
    public void PutLoadOrder_Answers400_WhenAPluginEntryOmitsARequiredField()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("put-load-order-bad-entry").WithPlugin("A.esp").Build();
        var request = new LoadOrderRequest(
            [new LoadOrderPlugin("A.esp", data.Plugins[0].Path, "", 0, true, true)],
            data.DataFolder, data.InstanceRoot, "Fallout4");

        var result = LoadOrderEndpoints.PutLoadOrder(request, TestEditService.PutLoadOrderHandler(holder), NullLoggerFactory.Instance);

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
    }

    // Two plugins, parked before the first: a create that lands mid-reconcile is neither waited on
    // nor cancelled by it, and the kernel ends up holding both.
    [Fact]
    public async Task CreatePlugin_DuringAnInFlightReconcile_NeitherWaitsForItNorCancelsIt()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("create-during-reconcile")
            .WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var factory = new GatedPluginAdapter(gateBefore: "A.esp");
        using var index = Indexes.Open(holder, factory);
        var snapshot = ForcedPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        holder.Apply(snapshot);
        var reconcile = Task.Run(() => index.Reconcile(snapshot));
        await factory.WaitUntilParkedAsync();

        var create = Task.Run(() => PluginEndpoints.CreatePlugin(
            new CreatePluginRequest("Interleaved.esp", Path.Combine(data.DataFolder, "InterleavedMod"), "InterleavedMod"),
            index, holder, TestEditService.PluginCreateHandler(holder), TestWatcher.Inert(), NullLoggerFactory.Instance));
        var created = await create.WaitAsync(TimeSpan.FromSeconds(10));
        factory.Release();
        await reconcile;

        Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(created);
        Assert.NotNull(holder.Current.Copy(new PluginCopyKey("Interleaved.esp", "InterleavedMod")));
        Assert.Contains(holder.Current.Copies, c => c.Name == "A.esp");
    }

    // ADR-0014: the rebuild endpoint's own refusal, at the handler seam.
    [ForeignIndexHolderFact]
    public void PostRebuildIndex_Answers423NamingTheOtherWindow_WhenAnotherProcessHoldsTheInstance()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("second-window-rebuild").WithPlugin("A.esp").Build();
        // The file exists before the other window takes it: an earlier launch on this instance made it.
        using (var earlier = Indexes.Reconciled(data, data.InstanceRoot)) { }
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        using var thisWindow = Indexes.Open(holder);
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
        using var index = Indexes.Open(holder);
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
