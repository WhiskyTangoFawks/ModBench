using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Traces;

/// <summary>compile-plugin: compile writes the source tree's documents back as the plugin's
/// bytes, so the proof is another load of those same bytes answering with the edit.</summary>
[Collection(WebHostCollection.Name)]
public sealed class CompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Compiled.esp";
    private const string Origin = "CompiledMod";

    private static ScatteredFixtureData OneTrackableMod() =>
        new PluginFixtureBuilder("trace-compile-a-plugin")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("CompiledNpc"), origin: Origin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> LoadedAndTracked()
    {
        var fx = OneTrackableMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> Compile(string origin) =>
        Client.PostAsJsonAsync($"/plugins/{Plugin}/compile", new { origin, @ref = (string?)null });

    [Fact]
    public async Task CompilingAnEditedPlugin_SucceedsAndItsBytesCarryTheEdit()
    {
        using var fx = await LoadedAndTracked();
        var formKey = await Client.FirstFormKey(Plugin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        var compiled = await Compile(Origin);

        compiled.EnsureSuccessStatusCode();
        var result = await compiled.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(result.GetProperty("succeeded").GetBoolean(), result.GetProperty("refusalReason").GetString());
        Assert.Equal(0.75, await HeightMaxOfTheWrittenBytes(fx, formKey), 3);
    }

    // A second service, loading the compiled file alone as an untracked plugin, so what answers is
    // the bytes on disk and nothing this host still holds in its own store.
    private static async Task<double> HeightMaxOfTheWrittenBytes(ScatteredFixtureData fx, string formKey)
    {
        using var elsewhere = new PluginFixtureBuilder("trace-compile-reader").BuildScattered();
        using var reader = new MEditHost();
        using var client = reader.CreateClient();
        var compiledFile = fx.Plugins.Single(p => p.Origin == Origin).Path;

        (await client.PutLoadOrder(
            elsewhere,
            [new LoadOrderEntry(Plugin, compiledFile, "ReadingMod", Slot: 0, Enabled: true, Winning: true)]))
            .EnsureSuccessStatusCode();

        var record = await client.Record(formKey);
        return record.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();
    }

    [Fact]
    public async Task CompilingWithoutAnOrigin_Is400()
    {
        using var fx = await LoadedAndTracked();

        var response = await Compile(string.Empty);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CompilingWhenTheBytesCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = await LoadedAndTracked();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        OtherTool.SetsThePermissions(modFolder, "500");
        try
        {
            var response = await Compile(Origin);

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700");
        }
    }
}
