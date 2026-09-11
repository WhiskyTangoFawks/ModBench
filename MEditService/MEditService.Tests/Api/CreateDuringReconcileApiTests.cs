using System.Net;
using System.Net.Http.Json;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

/// <summary>ADR-0013: both holder writers are the API's, so a snapshot and a create landing at once
/// compose rather than overwrite each other.</summary>
[Collection(WebHostCollection.Name)]
public sealed class CreateDuringReconcileApiTests
{
    // The reconcile parks inside the Index, which is where a create can be raced against it over
    // the wire; nothing else about the host changes.
    private sealed class ParkedReconcileApp : WebApplicationFactory<Program>
    {
        internal GatedIndexRepositoryFactory Index { get; } = new(
            new DuckDbRecordIndexFactory(
                SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)),
            gateBefore: "A.esp");

        protected override void ConfigureWebHost(IWebHostBuilder builder) =>
            builder.ConfigureTestServices(services => services.AddSingleton(sp => new IndexProjector(
                sp.GetRequiredService<LoadOrderHolder>(), sp.GetRequiredService<IPluginAdapter>(), Index)));

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing) Index.Dispose();
        }
    }

    [Fact]
    public async Task AReconcileRacingACreate_KeepsBothTheSnapshotsCopiesAndTheCreatedOne()
    {
        using var data = new PluginFixtureBuilder("create-during-reconcile-http")
            .WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var app = new ParkedReconcileApp();
        using var client = app.CreateClient();

        var put = client.PutAsJsonAsync("/load-order", new
        {
            plugins = data.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameDirectory = data.DataFolder,
            instanceRoot = data.InstanceRoot,
            gameRelease = "Fallout4",
        });
        await app.Index.WaitUntilParkedAsync();

        var created = await client.PostAsJsonAsync("/plugins/create", new
        {
            name = "Minted.esp",
            path = Path.Combine(data.DataFolder, "MintedMod"),
            origin = "MintedMod",
        });

        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        app.Index.Release();
        Assert.Equal(HttpStatusCode.OK, (await put).StatusCode);

        var held = app.Services.GetRequiredService<LoadOrderHolder>().Current;
        Assert.Equal(
            ["A.esp", "B.esp", "Minted.esp"],
            held.Copies.Select(copy => copy.Name).Order(StringComparer.Ordinal));
    }
}
