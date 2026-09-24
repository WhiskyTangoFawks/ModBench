using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>autocrlf=false keeps byte equality for dirty detection; gpgsign=false stops a signing
/// config hanging a commit; gc.autoDetach=false keeps a repack inside the command that triggered
/// it; the identity fallback touches no real global identity.</summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryTrackConfigTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-config-").FullName;

    private static void Track(string modFolder) =>
        PluginBaselines.Track(
            modFolder, SourcePreset.Edits,
            [new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())]);

    [Fact]
    public void Track_PinsAutocrlfFalseGpgsignFalseAndGcAutoDetachFalse_RepoLocal()
    {
        var modFolder = NewModFolder();
        try
        {
            Track(modFolder);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal("false", GitProbe.Run(gitDir, modFolder, "config", "--get", "core.autocrlf").Trim());
            Assert.Equal("false", GitProbe.Run(gitDir, modFolder, "config", "--get", "commit.gpgsign").Trim());
            Assert.Equal("false", GitProbe.Run(gitDir, modFolder, "config", "--get", "gc.autoDetach").Trim());
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
        var previousGitConfigNoSystem = Environment.GetEnvironmentVariable("GIT_CONFIG_NOSYSTEM");
        try
        {
            Environment.SetEnvironmentVariable("HOME", emptyHome);
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", Path.Combine(emptyHome, ".config"));
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", Path.Combine(emptyHome, "nonexistent-gitconfig"));
            // HOME/XDG/GIT_CONFIG_GLOBAL only scrub the *global* scope — a host
            // /etc/gitconfig (system scope) could still leak a real user.name/user.email in and
            // silently make this "fresh machine" repro not one.
            Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", "1");

            Track(modFolder);

            var gitDir = Path.Combine(modFolder, ".git");
            var author = GitProbe.Run(gitDir, modFolder, "log", "-1", "--format=%an <%ae>", "main").Trim();
            Assert.Equal("Modbench <modbench@localhost>", author);
        }
        finally
        {
            Environment.SetEnvironmentVariable("HOME", previousHome);
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", previousXdg);
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", previousGitConfigGlobal);
            Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", previousGitConfigNoSystem);
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(emptyHome, recursive: true);
        }
    }
}
