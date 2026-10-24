using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryInitConfigTests
{
    private static void Init(string modFolder) => Assert.Null(TestAdapters.Source().Init(modFolder, [PluginBaselines.OneRecordOf("Test.esp")]));

    [Theory]
    [InlineData("core.autocrlf", "false")]
    [InlineData("core.longpaths", "true")]
    [InlineData("core.quotePath", "false")]
    [InlineData("commit.gpgsign", "false")]
    [InlineData("gc.autoDetach", "false")]
    public void AnInit_IsSetAsEveryRepositoryModbenchMakes(string key, string value)
    {
        using var modFolder = new ScratchDirectory("medit-init-config-");

        Init(modFolder);

        Assert.Equal(value, GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "config", "--local", "--get", key).Trim());
    }

    [Fact]
    public void AnInitWithNoGlobalIdentityConfigured_StillCommits_WithARepoLocalFallbackIdentity()
    {
        using var modFolder = new ScratchDirectory("medit-init-config-");
        using var emptyHome = new ScratchDirectory("medit-init-config-home-");

        RunWithHomeXdgAndGlobalGitConfigScrubbedAndSystemGitConfigDisabled(emptyHome, () => Init(modFolder));

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
