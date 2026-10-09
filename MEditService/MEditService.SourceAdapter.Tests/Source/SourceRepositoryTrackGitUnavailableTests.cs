using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryTrackGitUnavailableTests
{
    [Fact]
    public void Track_WithGitNotOnPath_RefusesThePluginSayingGitIsNotOnPath_AndLeavesTheFolderEmpty()
    {
        using var modFolder = new ScratchDirectory("medit-track-nogit-");
        var previousPath = Environment.GetEnvironmentVariable("PATH");
        try
        {
            Environment.SetEnvironmentVariable("PATH", string.Empty);

            var files = new[] { new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var (plugin, reason) = Assert.Single(SourceRepository.Track(modFolder, PluginBaselines.Of(files)));

            Assert.Equal("Test.esp", plugin);
            Assert.Equal("git was not found on PATH. Modbench's tracking features require git to be installed and on PATH.", reason);
            Assert.Empty(Directory.EnumerateFileSystemEntries(modFolder));
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previousPath);
        }
    }
}
