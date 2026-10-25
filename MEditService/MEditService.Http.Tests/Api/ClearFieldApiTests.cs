using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class ClearFieldApiTests : HostedTests
{
    private const string Origin = "ClearableMod";
    private const string Plugin = "Clearable.esp";

    [Fact]
    public async Task ASetOfJsonNull_ClearsTheMember()
    {
        var fx = Owned(new PluginFixtureBuilder("api-clear-field")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx, Origin)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx, Origin);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var created = await Client.CreateRecord(Plugin, Origin, "npc_");
        created.EnsureSuccessStatusCode();
        var formKey = JsonStrings.Of((await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("formKey"));
        await Client.NextSnapshot(fx, Origin);
        await Wire.Eventually(
            async () => (await Client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(formKey)}", UriKind.Relative))).IsSuccessStatusCode,
            "the created record reached the record index");

        var url = new Uri($"/records/{Uri.EscapeDataString(formKey)}", UriKind.Relative);
        async Task<bool> HoldsHeight() => (await Client.GetStringAsync(url)).Contains("0.75", StringComparison.Ordinal);

        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx, Origin);
        await Wire.Eventually(HoldsHeight, "the set reached the record index");

        var cleared = await Client.Edit(formKey, Plugin, Origin, "HeightMax", JsonDocument.Parse("null").RootElement);
        Assert.True(cleared.IsSuccessStatusCode, await cleared.Content.ReadAsStringAsync());
        await Client.NextSnapshot(fx, Origin);

        await Wire.Eventually(async () => !await HoldsHeight(), "the clear reached the record index");
    }
}
