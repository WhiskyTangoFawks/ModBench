using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class ScriptRecordWriteTests
{
    private static RecordEditResult Copy(CopyFixture mod, CopyMode mode, PluginAddress destination) =>
        mod.ScriptCopyHandler.Copy(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mode, destination, replace: false)
            .GetAwaiter().GetResult();

    private static RecordEditResult Delete(SourceEditFixture mod, string formKey) =>
        mod.ScriptDeleteHandler.Delete(new RecordAt(mod.Plugin, formKey)).GetAwaiter().GetResult();

    [Fact]
    public void ACopyAsOverride_IsWrittenToTheDestinationsTree()
    {
        using var mod = CopyFixture.Create();

        var outcome = Copy(mod, CopyMode.Override, mod.DestinationPlugin);

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Equal(mod.SourceNpc.ToString(), outcome.NewFormKey);
        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()));
    }

    [Fact]
    public void ACopyAsNew_IsWrittenToTheDestinationsTree_AndAnswersTheNewFormKey()
    {
        using var mod = CopyFixture.Create();

        var outcome = Copy(mod, CopyMode.New, mod.DestinationPlugin);

        Assert.True(outcome.Applied, outcome.Message);
        Assert.NotEqual(mod.SourceNpc.ToString(), outcome.NewFormKey.Require());
        Assert.NotNull(mod.Document(mod.DestinationPlugin, outcome.NewFormKey.Require()));
    }

    [Fact]
    public void ACopyIntoAnUntrackedPlugin_IsRefused()
    {
        using var mod = CopyFixture.Create();

        var outcome = Copy(mod, CopyMode.New, mod.SourcePlugin);

        Assert.Equal(RecordEditRefusal.PluginNotTracked, outcome.Refusal);
    }

    [Fact]
    public void ACopyReachingAFileHeldUnsaved_IsRefusedAsUnsavedChanges_AndWritesNothing()
    {
        using var mod = CopyFixture.Create();
        var header = Path.Combine(mod.DestinationModFolder, SourceModTree.HeaderDocumentFile(mod.DestinationModFolder, mod.DestinationPlugin));
        mod.Unsaved.Apply([new DocumentChange(header, File.ReadAllText(header) + " ")]);
        var before = SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin);

        var outcome = Copy(mod, CopyMode.New, mod.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.DestinationModFolder, mod.DestinationPlugin));
    }

    [Fact]
    public void ACreate_IsWrittenToTheTree_AndAnswersTheNewFormKey()
    {
        using var mod = SourceEditFixture.Tracked();

        var outcome = mod.ScriptCreateHandler.Create(mod.Plugin, "npc_");

        Assert.True(outcome.Applied, outcome.Message);
        Assert.NotNull(mod.Document(outcome.NewFormKey.Require()));
    }

    [Fact]
    public void ACreateReachingAFileHeldUnsaved_IsRefusedAsUnsavedChanges_AndWritesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var header = Path.Combine(mod.ModFolder, SourceModTree.HeaderDocumentFile(mod.ModFolder, mod.Plugin));
        mod.Unsaved.Apply([new DocumentChange(header, File.ReadAllText(header) + " ")]);
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var outcome = mod.ScriptCreateHandler.Create(mod.Plugin, "npc_");

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void ADelete_RemovesTheRecordsFile()
    {
        using var mod = SourceEditFixture.Tracked();

        var outcome = Delete(mod, mod.Npc.ToString());

        Assert.True(outcome.Applied, outcome.Message);
        Assert.Null(mod.Document(mod.Npc.ToString()));
    }

    [Fact]
    public void ADeleteOfAFileHeldUnsaved_IsRefusedAsUnsavedChanges_AndWritesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var file = Path.Combine(mod.ModFolder, mod.DocumentFile(mod.Npc.ToString()).Require());
        mod.Unsaved.Apply([new DocumentChange(file, File.ReadAllText(file) + " ")]);

        var outcome = Delete(mod, mod.Npc.ToString());

        Assert.Equal(RecordEditRefusal.UnsavedChanges, outcome.Refusal);
        Assert.True(File.Exists(file));
    }

    [Fact]
    public void ADeleteOfTheHeader_IsRefused_AndWritesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = SourceModTree.Records(mod.ModFolder, mod.Plugin);

        var outcome = Delete(mod, PluginHeader.IdentityOf(mod.ActualPluginName).FormKey);

        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, outcome.Refusal);
        Assert.Equal(before, SourceModTree.Records(mod.ModFolder, mod.Plugin));
    }
}
