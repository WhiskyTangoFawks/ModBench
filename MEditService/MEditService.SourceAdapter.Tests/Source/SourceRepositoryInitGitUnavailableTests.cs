using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryInitGitUnavailableTests
{
    [Fact]
    public void AnInitWithGitNotOnPath_IsRefusedSayingGitIsNotOnPath_AndLeavesTheFolderEmpty()
    {
        using var modFolder = new ScratchDirectory("medit-init-nogit-");

        var failure = GitOffPath.While(() => TestAdapters.Source().Init(modFolder, [PluginBaselines.OneRecordOf("Test.esp")]));

        Assert.Equal(
            "git was not found on PATH. Modbench's source mod features require git to be installed and on PATH.", failure.Require().Reason);
        Assert.Empty(Directory.EnumerateFileSystemEntries(modFolder));
    }
}
