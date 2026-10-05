using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryTrackGitUnavailableTests
{
    [Fact]
    public void Track_WithGitNotOnPath_ThrowsGitUnavailableException_NotARawProcessException()
    {
        using var modFolder = new ScratchDirectory("medit-track-nogit-");
        var previousPath = Environment.GetEnvironmentVariable("PATH");
        try
        {
            Environment.SetEnvironmentVariable("PATH", string.Empty);

            var files = new[] { new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var ex = Assert.Throws<GitUnavailableException>(() =>
                PluginBaselines.Track(modFolder, files));

            Assert.Contains("git", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("PATH", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previousPath);
        }
    }
}
