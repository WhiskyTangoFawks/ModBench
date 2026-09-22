using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.SourceRepo.Tests.TestSupport;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>Git missing from PATH is one typed failure, checked once, early, never a raw
/// <c>Win32Exception</c> from the first <c>Process.Start</c> (ADR-0019).</summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryTrackGitUnavailableTests
{
    [Fact]
    public void Track_WithGitNotOnPath_ThrowsGitUnavailableException_NotARawProcessException()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-track-nogit-").FullName;
        var previousPath = Environment.GetEnvironmentVariable("PATH");
        try
        {
            // Scrub PATH for this process (and the child processes it spawns) so "git" genuinely
            // cannot be found — a real repro of the missing-git-on-PATH environment, not a mock.
            Environment.SetEnvironmentVariable("PATH", string.Empty);

            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var ex = Assert.Throws<GitUnavailableException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.Contains("git", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("PATH", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previousPath);
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
