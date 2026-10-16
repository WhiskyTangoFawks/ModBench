using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryDeletedGitTests
{
    [Fact]
    public void DeletingGit_MakesIsSourceModFalseAgain_WithSourceFilesUntouched()
    {
        using var modFolder = new ScratchDirectory("medit-deleted-git-");
        var relativePath = Path.Combine("plugin-source", "Test.esp", "npc_", "Test.esp", "000001.json");
        var content = "{\"formKey\":\"000001:Test.esp\"}"u8.ToArray();
        PluginBaselines.Init(
            modFolder,
            [new TreeFile(relativePath, content)]);

        var sourceFilePath = Path.Combine(modFolder, relativePath);
        Assert.True(TestAdapters.Source().IsSourceMod(modFolder));
        Assert.True(File.Exists(sourceFilePath));
        Assert.Equal(content, File.ReadAllBytes(sourceFilePath));

        AnotherTool.Delete(Path.Combine(modFolder, ".git"));

        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
        Assert.True(File.Exists(sourceFilePath), "the source text is not registry-backed and must survive .git's deletion");
        Assert.Equal(content, File.ReadAllBytes(sourceFilePath));
    }
}
