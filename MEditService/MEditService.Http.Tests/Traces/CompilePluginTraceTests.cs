using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Http.Tests.TestSupport.Wire;

namespace MEditService.Http.Tests.Traces;

public sealed class CompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Compiled.esp";
    private const string Origin = "CompiledMod";
    private const string OtherPlugin = "AlsoCompiled.esp";
    private const string OtherOrigin = "AlsoCompiledMod";
    private const string NonCompiledPlugin = "NonCompiledPlugin.esp";
    private const string NonCompiledPluginOrigin = "NonSourceMod";

    private static ScatteredFixtureData ThreeMods() =>
        new PluginFixtureBuilder("trace-compile-a-plugin")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("CompiledNpc"), origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("AlsoCompiledNpc"), origin: OtherOrigin)
            .WithPlugin(NonCompiledPlugin, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: NonCompiledPluginOrigin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> LoadedAndCompiledPlugin()
    {
        var fx = ThreeMods();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit([Origin, OtherOrigin])).EnsureSuccessStatusCode();
        return fx;
    }

    [Fact]
    public async Task CompilingAnEditedPlugin_AnswersItApplied_AndItsBytesCarryTheEdit()
    {
        using var fx = await LoadedAndCompiledPlugin();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        var answer = await Answer(await Client.Compile([(Plugin, Origin)]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var applied = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal((Plugin, Origin), (applied.GetProperty("name").GetString(), applied.GetProperty("origin").GetString()));
        Assert.Equal(0.75, await HeightMaxInTheBytesAt(Written(fx, Origin), formKey), 3);
    }

    [Fact]
    public async Task CompilingASelection_WithANonCompiledPlugin_CompilesTheOthers_AndRefusesItByName()
    {
        using var fx = await LoadedAndCompiledPlugin();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var otherFormKey = await Client.FirstFormKey(OtherPlugin, OtherOrigin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await Client.Edit(otherFormKey, OtherPlugin, OtherOrigin, "HeightMax", 0.5)).EnsureSuccessStatusCode();

        var answer = await Answer(await Client.Compile(
            [(Plugin, Origin), (NonCompiledPlugin, NonCompiledPluginOrigin), (OtherPlugin, OtherOrigin)]));

        Assert.Equal(
            [(Plugin, Origin), (OtherPlugin, OtherOrigin)],
            answer.GetProperty("applied").EnumerateArray()
                .Select(p => (p.GetProperty("name").GetString(), p.GetProperty("origin").GetString())));
        var refused = Assert.Single(answer.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            (NonCompiledPlugin, NonCompiledPluginOrigin),
            (refused.GetProperty("item").GetProperty("name").GetString(), refused.GetProperty("item").GetProperty("origin").GetString()));
        Assert.Equal("PluginNotCompiledPlugin", refused.GetProperty("refusal").GetString());
        Assert.Equal(
            $"{NonCompiledPlugin} is not a compiled plugin, so there is no source to compile.",
            refused.GetProperty("message").GetString());
        Assert.Equal(0.75, await HeightMaxInTheBytesAt(Written(fx, Origin), formKey), 3);
        Assert.Equal(0.5, await HeightMaxInTheBytesAt(Written(fx, OtherOrigin), otherFormKey), 3);
    }

    private static string Written(ScatteredFixtureData fx, string origin) => fx.Plugins.Single(p => p.Origin == origin).Path;

    [Theory]
    [InlineData("[]")]
    [InlineData("[{\"name\": \"Compiled.esp\", \"origin\": \"\"}]")]
    public async Task CompilingNoPlugin_OrAPluginWithoutAnOrigin_Is400(string plugins)
    {
        using var fx = await LoadedAndCompiledPlugin();

        var response = await Client.PostJson("/plugins/compile", $"{{\"plugins\": {plugins}}}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [PosixFact]
    public async Task CompilingWhenOnePluginsBytesCannotBeWritten_RefusesItByName_AndCompilesTheOthers()
    {
        using var fx = await LoadedAndCompiledPlugin();
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
