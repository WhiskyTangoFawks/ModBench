using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class WriteWaitsApiTests : HostedTests
{
    private const string Plugin = "Waited.esp";
    private const string Origin = "WaitedMod";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly TaskCompletionSource<long> _writerAwaits = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<IndexRefused?> _indexReads = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override MEditHost CreateHost() => new(services => AwaitingQueries.Replace(services, before =>
    {
        _writerAwaits.TrySetResult(before);
        return _indexReads.Task;
    }));

    private async Task<string> LoadedNpc()
    {
        var fx = Owned(new PluginFixtureBuilder("api-write-waits")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("WaitedNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        return await Client.FirstFormKey(Plugin, Origin);
    }

    [Fact]
    public async Task AScriptEdit_Answers_OnlyOnceTheRecordIndexHasReadIt()
    {
        var formKey = await LoadedNpc();

        var edit = Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75);
        await _writerAwaits.Task.WaitAsync(Generous);

        Assert.False(edit.IsCompleted);
        _indexReads.SetResult(null);
        Assert.Equal(HttpStatusCode.OK, (await edit.WaitAsync(Generous)).StatusCode);
    }

    [Fact]
    public async Task AScriptEdit_TheRecordIndexCannotRead_IsRefusedAsIndexNotReady()
    {
        var formKey = await LoadedNpc();
        _indexReads.SetResult(new IndexRefused(IndexRefusal.IndexNotReady, "mEdit's record index has not read the plugin source mEdit wrote."));

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75).WaitAsync(Generous);

        var problem = await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
        Assert.Equal(nameof(IndexRefusal.IndexNotReady), problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AScriptEditThatWritesNothing_DoesNotWait()
    {
        var formKey = await LoadedNpc();

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "NoSuchMember", 1).WaitAsync(Generous);

        Assert.False(response.IsSuccessStatusCode);
        Assert.False(_writerAwaits.Task.IsCompleted);
    }

    [Fact]
    public async Task AReadAfterAWrite_DoesNotWait()
    {
        await LoadedNpc();

        var response = await Client.GetAsync(new Uri("/plugins", UriKind.Relative)).WaitAsync(Generous);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(_writerAwaits.Task.IsCompleted);
    }
}
