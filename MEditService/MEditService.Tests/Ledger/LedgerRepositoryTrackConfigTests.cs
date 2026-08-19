using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #414/ADR-0041 (comment 2 pinned decisions, orchestrator rulings 2/3): repo-local config Track
/// pins at init. <c>core.autocrlf=false</c> is the byte-equality invariant dirty/ITM detection
/// depends on; <c>commit.gpgsign=false</c> stops a global signing config from hanging a plumbing
/// commit on a passphrase prompt; the identity fallback only fires when the effective (global)
/// identity is unset, and never touches a real global identity.
/// </summary>
public sealed class LedgerRepositoryTrackConfigTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-config-").FullName;

    private static void Track(string modFolder) =>
        LedgerRepository.Track(
            modFolder, LedgerPreset.Edits,
            [new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray())],
            new TrackProvenance(null, null, new Dictionary<string, string>()));

    [Fact]
    public void Track_PinsAutocrlfFalseAndGpgsignFalse_RepoLocal()
    {
        var modFolder = NewModFolder();
        try
        {
            Track(modFolder);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal("false", GitCli.Run(gitDir, modFolder, "config", "--get", "core.autocrlf").Trim());
            Assert.Equal("false", GitCli.Run(gitDir, modFolder, "config", "--get", "commit.gpgsign").Trim());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_WithNoGlobalIdentityConfigured_StillCommits_WithARepoLocalFallbackIdentity()
    {
        var modFolder = NewModFolder();
        // Point HOME/XDG at an empty scratch dir so `git config --get user.name/user.email`
        // (global/system scope) genuinely resolves to nothing — a real "fresh machine" repro,
        // not an assumption about this environment's own global git config.
        var emptyHome = Directory.CreateTempSubdirectory("medit-track-config-home-").FullName;
        var previousHome = Environment.GetEnvironmentVariable("HOME");
        var previousXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        var previousGitConfigGlobal = Environment.GetEnvironmentVariable("GIT_CONFIG_GLOBAL");
        try
        {
            Environment.SetEnvironmentVariable("HOME", emptyHome);
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", Path.Combine(emptyHome, ".config"));
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", Path.Combine(emptyHome, "nonexistent-gitconfig"));

            Track(modFolder);

            var gitDir = Path.Combine(modFolder, ".git");
            var author = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%an <%ae>", "main").Trim();
            Assert.Equal("Modbench <modbench@localhost>", author);
        }
        finally
        {
            Environment.SetEnvironmentVariable("HOME", previousHome);
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", previousXdg);
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", previousGitConfigGlobal);
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(emptyHome, recursive: true);
        }
    }
}
