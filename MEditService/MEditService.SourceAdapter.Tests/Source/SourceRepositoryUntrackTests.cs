using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryUntrackTests
{
    [Fact]
    public void DeletingGit_MakesIsTrackedFalseAgain_WithSourceFilesUntouched()
    {
        using var modFolder = new ScratchDirectory("medit-untrack-");
        var relativePath = Path.Combine("plugin-source", "Test.esp", "npc_", "Test.esp", "000001.json");
        var content = "{\"formKey\":\"000001:Test.esp\"}"u8.ToArray();
        PluginBaselines.Track(
            modFolder,
            [new TreeFile(relativePath, content)]);

        var sourceFilePath = Path.Combine(modFolder, relativePath);
        Assert.True(TestAdapters.Source().IsTracked(modFolder));
        Assert.True(File.Exists(sourceFilePath));
        Assert.Equal(content, File.ReadAllBytes(sourceFilePath));

        Directory.Delete(Path.Combine(modFolder, ".git"), recursive: true);

        Assert.False(TestAdapters.Source().IsTracked(modFolder));
        Assert.True(File.Exists(sourceFilePath), "the source text is not registry-backed and must survive .git's deletion");
        Assert.Equal(content, File.ReadAllBytes(sourceFilePath));
    }
}
