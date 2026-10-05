using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class CompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Compiled.esp";
    private const string Origin = "CompiledMod";
    private const string OtherPlugin = "AlsoCompiled.esp";
    private const string OtherOrigin = "AlsoCompiledMod";
    private const string UntrackedPlugin = "Untracked.esp";
    private const string UntrackedOrigin = "UntrackedMod";

    private static ScatteredFixtureData ThreeMods() =>
        new PluginFixtureBuilder("trace-compile-a-plugin")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("CompiledNpc"), origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("AlsoCompiledNpc"), origin: OtherOrigin)
            .WithPlugin(UntrackedPlugin, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: UntrackedOrigin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> LoadedAndTracked()
    {
        var fx = ThreeMods();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track([Origin, OtherOrigin])).EnsureSuccessStatusCode();
        return fx;
    }

    private static async Task<JsonElement> Answer(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task CompilingAnEditedPlugin_AnswersItApplied_AndItsBytesCarryTheEdit()
    {
        using var fx = await LoadedAndTracked();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        var answer = await Answer(await Client.Compile([(Plugin, Origin)]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var applied = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal((Plugin, Origin), (applied.GetProperty("name").GetString(), applied.GetProperty("origin").GetString()));
        Assert.Equal(0.75, await HeightMaxOfTheWrittenBytes(fx, Plugin, Origin, formKey), 3);
    }

    [Fact]
    public async Task CompilingASelection_WithAnUntrackedPlugin_CompilesTheOthers_AndRefusesItByName()
    {
        using var fx = await LoadedAndTracked();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var otherFormKey = await Client.FirstFormKey(OtherPlugin, OtherOrigin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await Client.Edit(otherFormKey, OtherPlugin, OtherOrigin, "HeightMax", 0.5)).EnsureSuccessStatusCode();

        var answer = await Answer(await Client.Compile(
            [(Plugin, Origin), (UntrackedPlugin, UntrackedOrigin), (OtherPlugin, OtherOrigin)]));

        Assert.Equal(
            [(Plugin, Origin), (OtherPlugin, OtherOrigin)],
            answer.GetProperty("applied").EnumerateArray()
                .Select(p => (p.GetProperty("name").GetString(), p.GetProperty("origin").GetString())));
        var refused = Assert.Single(answer.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            (UntrackedPlugin, UntrackedOrigin),
            (refused.GetProperty("item").GetProperty("name").GetString(), refused.GetProperty("item").GetProperty("origin").GetString()));
        Assert.Equal("PluginNotTracked", refused.GetProperty("refusal").GetString());
        Assert.Equal(
            $"{UntrackedPlugin} is not tracked, so there is no source to compile.",
            refused.GetProperty("message").GetString());
        Assert.Equal(0.75, await HeightMaxOfTheWrittenBytes(fx, Plugin, Origin, formKey), 3);
        Assert.Equal(0.5, await HeightMaxOfTheWrittenBytes(fx, OtherPlugin, OtherOrigin, otherFormKey), 3);
    }

    [Fact]
    public async Task CompilingASelectionNamingAPluginTwice_AnswersItAppliedOnce()
    {
        using var fx = await LoadedAndTracked();

        var answer = await Answer(await Client.Compile([(Plugin, Origin), (Plugin, Origin)]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        Assert.Single(answer.GetProperty("applied").EnumerateArray());
    }

    [Fact]
    public async Task Compiling_LeavesNoOtherPluginFileInTheModsRoot()
    {
        using var fx = await LoadedAndTracked();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        await Answer(await Client.Compile([(Plugin, Origin)]));
        await Answer(await Client.Compile([(Plugin, Origin)]));

        Assert.Equal(
            [Plugin],
            Directory.EnumerateFiles(OtherTool.ModFolderOf(fx, Origin), "*.esp").Select(Path.GetFileName));
    }

    private static async Task<double> HeightMaxOfTheWrittenBytes(
        ScatteredFixtureData fx, string plugin, string origin, string formKey) =>
        (await RecordInTheWrittenBytes(fx, plugin, origin, formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();

    private static async Task<JsonElement> RecordInTheWrittenBytes(
        ScatteredFixtureData fx, string plugin, string origin, string formKey)
    {
        using var elsewhere = new PluginFixtureBuilder("trace-compile-reader").BuildScattered();
        using var reader = new MEditHost();
        using var client = reader.CreateClient();
        var copied = Path.Combine(Directory.CreateDirectory(Path.Combine(elsewhere.Root, "ReadingMod")).FullName, plugin);
        File.Copy(fx.Plugins.Single(p => p.Origin == origin).Path, copied);

        (await client.PutLoadOrder(
            elsewhere,
            [new LoadOrderEntry(plugin, copied, "ReadingMod", Slot: 0, Enabled: true, Winning: true)]))
            .EnsureSuccessStatusCode();

        return await client.Record(formKey);
    }

    [Fact]
    public async Task CompilingBeforeAnyLoadOrder_RefusesTheWholeSelectionOnce_503()
    {
        var response = await Client.Compile([(Plugin, Origin), (OtherPlugin, OtherOrigin)]);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("No load order has been received.", problem.GetProperty("detail").GetString());
        Assert.False(problem.TryGetProperty("refused", out _), "The whole selection is refused once, not per plugin.");
    }

    [Fact]
    public async Task CompilingNoPlugin_Is400()
    {
        using var fx = await LoadedAndTracked();

        var response = await Client.Compile([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CompilingAPluginWithoutAnOrigin_Is400()
    {
        using var fx = await LoadedAndTracked();

        var response = await Client.Compile([(Plugin, string.Empty)]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CompilingWhenOnePluginsBytesCannotBeWritten_RefusesItByName_AndCompilesTheOthers()
    {
        using var fx = await LoadedAndTracked();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        OtherTool.SetsThePermissions(modFolder, "500");
        try
        {
            var answer = await Answer(await Client.Compile([(Plugin, Origin), (OtherPlugin, OtherOrigin)]));

            Assert.Equal(
                [OtherPlugin],
                answer.GetProperty("applied").EnumerateArray().Select(a => a.GetProperty("name").GetString()));
            var refused = Assert.Single(answer.GetProperty("refused").EnumerateArray());
            Assert.Equal(Plugin, refused.GetProperty("item").GetProperty("name").GetString());
            Assert.Equal("WriteFailed", refused.GetProperty("refusal").GetString());
            Assert.StartsWith($"Could not write {Plugin}: ", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700");
        }
    }
}
