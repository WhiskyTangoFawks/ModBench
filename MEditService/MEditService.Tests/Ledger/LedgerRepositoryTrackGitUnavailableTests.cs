using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #414/ADR-0041 (comment 1): git-on-PATH missing surfaces one typed failure, checked once, early —
/// never an exception cascade (a raw <c>Win32Exception</c> from the first <c>Process.Start</c> that
/// happens to hit it), per ADR-0026 and <c>MEditService/CLAUDE.md</c>'s "never <c>ex.ToString()</c>"
/// rule, both of which depend on the caller being able to catch one named type.
/// </summary>
public sealed class LedgerRepositoryTrackGitUnavailableTests
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

            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var ex = Assert.Throws<GitUnavailableException>(() =>
                LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>())));

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
