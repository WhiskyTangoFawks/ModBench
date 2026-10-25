using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideTests
{
    [Fact]
    public void CopyRecordAsOverride_FromANonCompiledPluginSource_LandsUnderTheSameFormKey()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var document = mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId, document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsOverride_FromACompiledPluginSource_ReadsItsCurrentDocument()
    {
        using var mod = CopyFixture.Create(initSource: true);
        var original = mod.Document(mod.SourcePlugin, mod.SourceNpc.ToString()).Require();
        mod.Overwrite(mod.SourcePlugin, original with { Body = original.Body.Replace(CopyFixture.SourceNpcEditorId, "MutatedOnDisk") });

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.Contains(
            "MutatedOnDisk", mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_FromANonCompiledPluginSource_WritesTheSameTextACompiledPluginSourceWould()
    {
        using var nonCompiledPlugin = CopyFixture.Create();
        using var compiledPlugin = CopyFixture.Create(initSource: true);

        nonCompiledPlugin.CopyHandler.CopySync([new RecordAt(nonCompiledPlugin.SourcePlugin, nonCompiledPlugin.SourceNpc.ToString())], CopyMode.Override, [nonCompiledPlugin.DestinationPlugin], replace: false).OnlyLanded();
        compiledPlugin.CopyHandler.CopySync([new RecordAt(compiledPlugin.SourcePlugin, compiledPlugin.SourceNpc.ToString())], CopyMode.Override, [compiledPlugin.DestinationPlugin], replace: false).OnlyLanded();

        Assert.Equal(
            compiledPlugin.Document(compiledPlugin.DestinationPlugin, compiledPlugin.SourceNpc.ToString()).Require().Body,
            nonCompiledPlugin.Document(nonCompiledPlugin.DestinationPlugin, nonCompiledPlugin.SourceNpc.ToString()).Require().Body);
    }

    [Fact]
    public void CopyRecordAsOverride_OfARecordTheDestinationDeletedSinceTheLastCommit_LandsItAgain()
    {
        using var mod = CopyFixture.Create();
        mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false).OnlyLanded();
        SourceModTree.Commit(mod.DestinationModFolder);
        Assert.Empty(mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.DestinationPlugin, mod.SourceNpc.ToString())]).Refused);

        mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.Override, [mod.DestinationPlugin], replace: false).OnlyLanded();

        Assert.NotNull(mod.Document(mod.DestinationPlugin, mod.SourceNpc.ToString()));
    }
}
