using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class ScriptRecordWriteTests
{
    private static RecordEditResult Copy(CopyFixture mod, CopyMode mode, PluginAddress destination) =>
        mod.ScriptCopyHandler.Copy(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mode, destination, replace: false, CancellationToken.None)
            .GetAwaiter().GetResult().AsResult();

    private static RecordEditResult Create(SourceEditFixture mod) =>
        mod.ScriptCreateHandler.Create(mod.Plugin, "npc_", container: null, position: null, CancellationToken.None).GetAwaiter().GetResult().AsResult();

    private static RecordEditResult Delete(SourceEditFixture mod, string formKey) =>
        mod.ScriptDeleteHandler.Delete(new RecordAt(mod.Plugin, formKey), CancellationToken.None).GetAwaiter().GetResult();

    private static void AssertHanded(TestInstance mod, PluginAddress plugin, string file)
    {
        var handed = Assert.Single(Assert.Single(mod.Index.Hands).Require());
        var document = Assert.Single(handed.Documents, document => document.Path == file);
        Assert.Equal((plugin, File.ReadAllText(file), FileStamp.Of(file)), (handed.Plugin, document.Text, document.Stamp));
    }

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
    public void ACopyIntoANonCompiledPlugin_IsRefused()
    {
        using var mod = CopyFixture.Create();

        var outcome = Copy(mod, CopyMode.New, mod.SourcePlugin);

        Assert.Equal(RecordEditRefusal.PluginNotCompiledPlugin, outcome.Refusal);
    }

    [Fact]
    public void ACreate_HandsTheRecordIndexTheDocumentItWrote()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var outcome = Create(mod);

        AssertHanded(mod, mod.Plugin, Path.Combine(mod.ModFolder, mod.DocumentFile(outcome.NewFormKey.Require()).Require()));
    }

    [Fact]
    public void ADelete_HandsTheRecordIndexItsPlugin_NamingTheFileItDeleted()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var file = Path.Combine(mod.ModFolder, mod.DocumentFile(mod.Npc.ToString()).Require());

        Delete(mod, mod.Npc.ToString());

        var handed = Assert.Single(Assert.Single(mod.Index.Hands).Require());
        Assert.Equal((mod.Plugin, file, 0), (handed.Plugin, Assert.Single(handed.Files.Require()), handed.Documents.Count));
    }
}
