using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EditRecordTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string NpcFile => Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require());

    private RecordEditResult EditHeightMax() =>
        _mod.ScriptEditHandler.Edit(_mod.Plugin, _mod.Npc.ToString(), SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax")));

    [Fact]
    public void AFieldEdit_IsWrittenToTheRecordsFile()
    {
        var outcome = EditHeightMax();

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Contains("0.75", File.ReadAllText(NpcFile), StringComparison.Ordinal);
    }

    [Fact]
    public void AFieldEditOfAFileHeldUnsaved_IsRefusedNamingTheFile_AndWritesNothing()
    {
        var saved = File.ReadAllText(NpcFile);
        _mod.Unsaved.Apply([new DocumentChange(NpcFile, saved + " ")]);

        var outcome = EditHeightMax();

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
        Assert.Contains(NpcFile, outcome.Message, StringComparison.Ordinal);
        Assert.Equal(saved, File.ReadAllText(NpcFile));
    }
}
