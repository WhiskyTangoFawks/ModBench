using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
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

    private RecordEditResult EditHeightMax() =>
        _mod.ScriptEditHandler.Edit(_mod.Plugin, _mod.Npc.ToString(), SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax")), copiesWithNoPluginSource: Envelopes.NoCopies)
            .GetAwaiter().GetResult().AsResult();

    [Fact]
    public void AFieldEdit_IsWrittenToTheRecordsFile()
    {
        var outcome = EditHeightMax();

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Contains("0.75", File.ReadAllText(NpcFile), StringComparison.Ordinal);
    }

    [Fact]
    public void AFieldEdit_HandsTheRecordIndexTheDocumentItWrote_WithTheStampItsFileTook_AndCountsNoWrite()
    {
        IReadOnlyCollection<PluginChange>? handed = null;
        _mod.Holder.Handed += (written, reads) =>
        {
            handed = written;
            reads.Add(Task.FromResult<string?>(null));
        };
        var own = _mod.Holder.BeginOwnWrites();

        EditHeightMax();

        var change = Assert.Single(handed.Require());
        var document = Assert.Single(change.Documents.Require());
        Assert.Equal((_mod.Plugin, NpcFile, File.ReadAllText(NpcFile), WrittenStamp.Of(NpcFile)), (change.Plugin, document.Path, document.Text, document.Stamp));
        Assert.Empty(own.Snapshot());
    }

    [Fact]
    public void AFieldEditTheRecordIndexCouldNotRead_IsAnsweredAsWritten()
    {
        _mod.Holder.Handed += (_, reads) => reads.Add(Task.FromResult<string?>("The record index could not read it."));

        Assert.True(EditHeightMax().Applied);
    }

    [Fact]
    public void AFieldEditOfAFileHeldUnsaved_IsRefusedAsUnsavedChanges()
    {
        var saved = File.ReadAllText(NpcFile);
        _mod.Unsaved.Apply([new DocumentChange(NpcFile, saved + " ")]);

        var outcome = EditHeightMax();

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
    }
}
