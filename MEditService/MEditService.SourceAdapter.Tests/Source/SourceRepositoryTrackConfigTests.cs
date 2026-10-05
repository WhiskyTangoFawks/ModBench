using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryTrackConfigTests
{
    private static void Track(string modFolder) =>
        PluginBaselines.Track(
            modFolder,
            [new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())]);

    private static string RepoLocalConfigAfterTrack(string key)
    {
        using var modFolder = new ScratchDirectory("medit-track-config-");
        Track(modFolder);
        return GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "config", "--local", "--get", key).Trim();
    }

    [Fact]
    public void Track_PinsAutocrlfFalse_SoDirtDetectionKeepsByteEquality() =>
        Assert.Equal("false", RepoLocalConfigAfterTrack("core.autocrlf"));

    [Fact]
    public void Track_PinsGpgsignFalse_SoASigningConfigCannotHangACommit() =>
        Assert.Equal("false", RepoLocalConfigAfterTrack("commit.gpgsign"));

    [Fact]
    public void Track_PinsGcAutoDetachFalse_SoARepackStaysInsideTheCommandThatTriggeredIt() =>
        Assert.Equal("false", RepoLocalConfigAfterTrack("gc.autoDetach"));

    [Fact]
    public void Track_WithNoGlobalIdentityConfigured_StillCommits_WithARepoLocalFallbackIdentity()
    {
        using var modFolder = new ScratchDirectory("medit-track-config-");
        using var emptyHome = new ScratchDirectory("medit-track-config-home-");

        RunWithHomeXdgAndGlobalGitConfigScrubbedAndSystemGitConfigDisabled(emptyHome, () => Track(modFolder));

        var gitDir = Path.Combine(modFolder, ".git");
        var author = GitProbe.Run(gitDir, modFolder, "log", "-1", "--format=%an <%ae>", "main").Trim();
        Assert.Equal("Modbench <modbench@localhost>", author);
    }

    private static void RunWithHomeXdgAndGlobalGitConfigScrubbedAndSystemGitConfigDisabled(string emptyHome, Action body)
    {
        string[] variables = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
        var previous = variables.Select(Environment.GetEnvironmentVariable).ToArray();
        try
        {
            Environment.SetEnvironmentVariable("HOME", emptyHome);
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", Path.Combine(emptyHome, ".config"));
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", Path.Combine(emptyHome, "nonexistent-gitconfig"));
            Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", "1");

            body();
        }
        finally
        {
            foreach (var (variable, value) in variables.Zip(previous))
                Environment.SetEnvironmentVariable(variable, value);
        }
    }
}
