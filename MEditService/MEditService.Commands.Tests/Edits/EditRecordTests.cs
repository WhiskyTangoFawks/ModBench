using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EditRecordTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.CompiledPlugin();

    public void Dispose() => _mod.Dispose();

    private string NpcFile => Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require());

    private Task<Answer<RecordEdited, RecordEditRefused>> EditingHeightMax(CancellationToken cancel = default) =>
        _mod.ScriptEditHandler.Edit(
            _mod.Plugin, _mod.Npc.ToString(), SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax")), Envelopes.NoCopies, cancel);

    private async Task<RecordEditResult> EditHeightMax() => (await EditingHeightMax()).AsResult();

    [Fact]
    public async Task AFieldEdit_IsWrittenToTheRecordsFile()
    {
        var outcome = await EditHeightMax();

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Contains("0.75", File.ReadAllText(NpcFile), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFieldEdit_HandsTheRecordIndexTheDocumentItWrote_WithTheStampItsFileTook()
    {
        await EditHeightMax();

        var plugin = Assert.Single(Assert.Single(_mod.Index.Hands).Require());
        var document = Assert.Single(plugin.Documents);
        Assert.Equal((_mod.Plugin, NpcFile, File.ReadAllText(NpcFile), FileStamp.Of(NpcFile)), (plugin.Plugin, document.Path, document.Text, document.Stamp));
    }

    [Fact]
    public async Task AFieldEdit_IsAnsweredOnlyOnceTheRecordIndexHoldsIt()
    {
        var held = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _mod.Index.Answer = () => held.Task;

        var editing = EditingHeightMax();

        Assert.False(editing.IsCompleted);
        held.SetResult(null);
        Assert.True((await editing).AsResult().Applied);
    }

    [Fact]
    public async Task AFieldEditWhoseCallerStopsWaiting_StopsWaiting_AndLeavesItsWriteOnDisk()
    {
        _mod.Index.Answer = () => new TaskCompletionSource<string?>().Task;
        using var abandoned = new CancellationTokenSource();

        var editing = EditingHeightMax(abandoned.Token);
        await abandoned.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => editing.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Contains("0.75", File.ReadAllText(NpcFile), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFieldEditTheRecordIndexCouldNotRead_IsAnsweredAsWritten()
    {
        _mod.Index.Answer = () => Task.FromResult<string?>("The record index could not read it.");

        Assert.True((await EditHeightMax()).Applied);
    }

    [Fact]
    public async Task AFieldEditOfAFileHeldUnsaved_IsRefusedAsUnsavedChanges()
    {
        var saved = File.ReadAllText(NpcFile);
        _mod.Unsaved.Apply([new DocumentChange(NpcFile, saved + " ")]);

        var outcome = await EditHeightMax();

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
    }
}
