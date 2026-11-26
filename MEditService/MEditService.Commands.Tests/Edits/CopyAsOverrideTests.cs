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
}
