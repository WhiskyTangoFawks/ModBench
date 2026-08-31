using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// ADR-0041: git-on-PATH missing surfaces one typed failure, checked once, early —
/// never an exception cascade (a raw <c>Win32Exception</c> from the first <c>Process.Start</c> that
/// happens to hit it), per ADR-0026 and <c>MEditService/CLAUDE.md</c>'s "never <c>ex.ToString()</c>"
/// rule, both of which depend on the caller being able to catch one named type.
/// </summary>
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
            // Belt-and-braces alongside PATH — a host /etc/gitconfig plays no part
            // in this scenario (git never launches at all), but scrubbing it keeps this test's
            // environment-scrubbing posture consistent with SourceRepositoryTrackConfigTests'
            // identity-fallback test, which does depend on it.
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
