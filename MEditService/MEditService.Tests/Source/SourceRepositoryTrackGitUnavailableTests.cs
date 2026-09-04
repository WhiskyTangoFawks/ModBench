using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>Git missing from PATH is one typed failure, checked once, early, never a raw
/// <c>Win32Exception</c> from the first <c>Process.Start</c> (ADR-0026).</summary>
public sealed class SourceRepositoryTrackGitUnavailableTests
{
    [Fact]
    public void Track_WithGitNotOnPath_ThrowsGitUnavailableException_NotARawProcessException()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-track-nogit-").FullName;
        var previousPath = Environment.GetEnvironmentVariable("PATH");
        var previousGitConfigNoSystem = Environment.GetEnvironmentVariable("GIT_CONFIG_NOSYSTEM");
        try
        {
            // Scrub PATH for this process (and the child processes it spawns) so "git" genuinely
            // cannot be found — a real repro of the missing-git-on-PATH environment, not a mock.
            Environment.SetEnvironmentVariable("PATH", string.Empty);
            // A host /etc/gitconfig plays no part here, git never launching at all, but scrubbing it
            // keeps this test's environment-scrubbing posture consistent with the identity-fallback
            // test that needs it.
            Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", "1");

            var files = new[] { new PristineFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var ex = Assert.Throws<GitUnavailableException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.Contains("git", ex.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("PATH", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previousPath);
            Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", previousGitConfigNoSystem);
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
