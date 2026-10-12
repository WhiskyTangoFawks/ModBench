using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class BuildModTraceTests : HostedTests
{
    private const string Plugin = "Built.esp";
    private const string SecondPlugin = "AlsoBuilt.esp";
    private const string Origin = "BuiltMod";
    private const string UntrackedPlugin = "Untracked.esp";
    private const string UntrackedOrigin = "UntrackedMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-build-mod")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("BuiltNpc"), origin: Origin)
        .WithPlugin(SecondPlugin, mod => mod.Npcs.AddNew("AlsoBuiltNpc"), origin: Origin)
        .WithPlugin(UntrackedPlugin, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: UntrackedOrigin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private string _builtFolder = string.Empty;

    // The fixture folders each plugin of its own: a mod's plugins share one folder.
    private async Task LoadedAndTracked()
    {
        _builtFolder = Path.GetDirectoryName(_instance.Plugins.Single(p => p.Name == Plugin).Path).Require();
        var second = _instance.Plugins.Single(p => p.Name == SecondPlugin);
        var movedTo = Path.Combine(_builtFolder, SecondPlugin);
        File.Move(second.Path, movedTo, overwrite: true);
        (await Client.PutLoadOrder(_instance, _instance.Plugins.Select(p => p == second ? p with { Path = movedTo } : p)))
            .EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> Answer(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task BuildingAMod_CompilesEveryPluginOfItFromItsSource_AndReportsItsProgress()
    {
        await LoadedAndTracked();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var otherFormKey = await Client.FirstFormKey(SecondPlugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await Client.Edit(otherFormKey, SecondPlugin, Origin, "HeightMax", 0.5)).EnsureSuccessStatusCode();
        using var stream = await Client.NotificationStream();

        var answer = await Answer(await Client.Build([Origin]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var built = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal(Origin, built.GetProperty("mod").GetString());
        Assert.Empty(built.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            [SecondPlugin, Plugin],
            built.GetProperty("compiled").EnumerateArray().Select(p => p.GetProperty("name").GetString()).Order());
        Assert.Equal(0.75, await HeightMaxOfTheWrittenBytes(Plugin, formKey), 3);
        Assert.Equal(0.5, await HeightMaxOfTheWrittenBytes(SecondPlugin, otherFormKey), 3);

        var progress = await stream.EventsUntil(
            "build-progress", e => e.GetProperty("buildProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("buildProgress").GetProperty("mod").GetString() == Origin);
    }

    [Fact]
    public async Task BuildingAModWhoseSourceIsUntracked_LandsItWithEachPluginRefusedByName()
    {
        await LoadedAndTracked();

        var answer = await Answer(await Client.Build([UntrackedOrigin, Origin]));

        Assert.Equal(
            [UntrackedOrigin, Origin],
            answer.GetProperty("applied").EnumerateArray().Select(m => m.GetProperty("mod").GetString()));
        var untracked = answer.GetProperty("applied")[0];
        Assert.Empty(untracked.GetProperty("compiled").EnumerateArray());
        var refused = Assert.Single(untracked.GetProperty("refused").EnumerateArray());
        Assert.Equal(UntrackedPlugin, refused.GetProperty("item").GetProperty("name").GetString());
        Assert.Equal("PluginNotTracked", refused.GetProperty("refusal").GetString());
        Assert.Equal(2, answer.GetProperty("applied")[1].GetProperty("compiled").GetArrayLength());
    }

    [Fact]
    public async Task BuildingBeforeAnyLoadOrder_RefusesTheWholeSelectionOnce_503()
    {
        var response = await Client.Build([Origin]);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("No load order has been received.", problem.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task BuildingNoMod_Is400()
    {
        await LoadedAndTracked();

        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Build([])).StatusCode);
    }

    [Fact]
    public async Task BuildingAModWithoutAName_Is400()
    {
        await LoadedAndTracked();

        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Build([" "])).StatusCode);
    }

    private async Task<double> HeightMaxOfTheWrittenBytes(string plugin, string formKey)
    {
        using var elsewhere = new PluginFixtureBuilder("trace-build-reader").BuildScattered();
        using var reader = new MEditHost();
        using var client = reader.CreateClient();
        var copied = Path.Combine(Directory.CreateDirectory(Path.Combine(elsewhere.Root, "ReadingMod")).FullName, plugin);
        File.Copy(Path.Combine(_builtFolder, plugin), copied);

        (await client.PutLoadOrder(
            elsewhere,
            [new LoadOrderEntry(plugin, copied, "ReadingMod", Line: 0, Enabled: true, Winning: true)]))
            .EnsureSuccessStatusCode();

        return (await client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();
    }
}
