using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class WriteWaitsApiTests : HostedTests
{
    private const string Plugin = "Waited.esp";
    private const string Origin = "WaitedMod";
    private const string OtherPlugin = "Other.esp";
    private const string OtherOrigin = "OtherMod";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly TaskCompletionSource<IReadOnlyList<SourceWrite>> _writerAwaits = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<IndexRefused?> _indexReads = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override MEditHost CreateHost() => new(services => AwaitingQueries.Replace(services, own =>
    {
        _writerAwaits.TrySetResult(own.Snapshot());
        return _indexReads.Task;
    }));

    private async Task<ScatteredFixtureData> Loaded(bool versioned = true)
    {
        var fx = Owned(new PluginFixtureBuilder("api-write-waits")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("WaitedNpc"), origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("OtherNpc"), origin: OtherOrigin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (versioned) (await Client.VersionInGit([Origin, OtherOrigin])).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task AssertTheWriteWaitsForTheIndex(Task<HttpResponseMessage> gesture)
    {
        var written = await _writerAwaits.Task.WaitAsync(Generous);

        Assert.NotEmpty(written);
        Assert.False(gesture.IsCompleted);
        _indexReads.SetResult(null);
        Assert.True((await gesture.WaitAsync(Generous)).IsSuccessStatusCode);
    }

    private static object Npc(string formKey, string plugin, string origin) => new { formKey, plugin = new { name = plugin, origin } };

    [Fact]
    public async Task AScriptEdit_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        await AssertTheWriteWaitsForTheIndex(Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75));
    }

    [Fact]
    public async Task AScriptCopy_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync(
            "/records/copy", new { record = Npc(formKey, Plugin, Origin), mode = "Override", destination = new { name = OtherPlugin, origin = OtherOrigin } }));
    }

    [Fact]
    public async Task AScriptDelete_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync("/records/delete", Npc(formKey, Plugin, Origin)));
    }

    [Fact]
    public async Task ACreateRecord_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync(
            $"/plugins/{Plugin}/create-record", new { origin = Origin, recordType = "npc_" }));
    }

    [Fact]
    public async Task ACreatePlugin_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        var fx = await Loaded();
        var folder = Directory.CreateDirectory(Path.Combine(fx.Root, "mod-minted")).FullName;

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync(
            "/plugins/create", new { origin = "MintedMod", name = "Minted.esp", folder, flags = Array.Empty<string>() }));
    }

    [Fact]
    public async Task ACreatePluginInMod_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        var fx = await Loaded();
        var emptyFolder = Directory.CreateDirectory(Path.Combine(fx.Root, "mod-empty")).FullName;
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins, places: new object[] { new { name = "EmptyMod", folder = emptyFolder } }))).EnsureSuccessStatusCode();

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync(
            "/plugins/create-in-mod", new { origin = "EmptyMod", name = "Patch.esp", flags = Array.Empty<string>() }));
    }

    [Fact]
    public async Task ADecompile_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();

        await AssertTheWriteWaitsForTheIndex(Client.Decompile([(Plugin, Origin)], force: true));
    }

    [Fact]
    public async Task ACompile_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        await Loaded();

        await AssertTheWriteWaitsForTheIndex(Client.Compile([(Plugin, Origin)]));
    }

    [Fact]
    public async Task ABuild_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        var fx = await Loaded();
        var folder = Path.GetDirectoryName(fx.Plugins.Single(plugin => plugin.Name == Plugin).Path).Require();

        await AssertTheWriteWaitsForTheIndex(Client.Build([(Origin, folder)], new { compile = new[] { Plugin } }));
    }

    [Fact]
    public async Task ADecompileAndRepair_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        var malformed = MalformationFixtures.ShortRegion.Malformed;
        using var fx = new PluginFixtureBuilder("api-write-waits-repair").WithPlugin(malformed.FileName, origin: "RepairedMod").BuildScattered();
        File.WriteAllBytes(Path.Combine(OtherTool.ModFolderOf(fx, "RepairedMod"), malformed.FileName), malformed.Bytes);
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var repair = new
        {
            plugin = new { name = malformed.FileName, origin = "RepairedMod" },
            sourceFolder = new { path = Client.SourceFolderSentFor("RepairedMod"), @in = "NewRepository", buildFile = "{}" },
        };

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync("/plugins/decompile-and-repair", new { plugins = new[] { repair }, force = false }));
    }

    [Fact]
    public async Task ASetOfPluginFileFlags_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        using var scratch = new ScratchDirectory("api-write-waits-flags-");
        var path = Path.Combine(scratch, "Flagged.esp");
        new Fallout4Mod(ModKey.FromFileName("Flagged.esp"), Fallout4Release.Fallout4).WriteToBinary(path);

        await AssertTheWriteWaitsForTheIndex(Client.PostAsJsonAsync(
            "/plugin-files/set-flags",
            new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } }));
    }

    [Fact]
    public async Task AWriteLandedThatTheRecordIndexCannotRead_AnswersItsOutcome_AndLogsThatTheIndexIsBehind()
    {
        await Loaded();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        _indexReads.SetResult(new IndexRefused(IndexRefusal.IndexNotReady, "mEdit's record index has not read the plugin source mEdit wrote."));

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75).WaitAsync(Generous);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.Contains("has not read the plugin source", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AScriptEditThatWritesNothing_DoesNotWait()
    {
        await Loaded();
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "NoSuchMember", 1).WaitAsync(Generous);

        Assert.False(response.IsSuccessStatusCode);
        Assert.False(_writerAwaits.Task.IsCompleted);
    }
}
