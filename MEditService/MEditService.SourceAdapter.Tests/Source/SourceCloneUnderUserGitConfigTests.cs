using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceCloneUnderUserGitConfigTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-clone-user-config-");

    public void Dispose() => _root.Dispose();

    [Fact]
    public void AClone_UnderAUserConfigThatNamesAnotherDefaultRemote_StillTakesTheRemotesMain()
    {
        var remote = Directory.CreateDirectory(Path.Combine(_root, "remote")).FullName;
        Git(remote, "init", "-q", "-b", "main");
        File.WriteAllText(Path.Combine(remote, "build.json"), "release");
        Git(remote, "add", "-A");
        Git(remote, "commit", "-q", "-m", "release");
        var release = Git(remote, "rev-parse", "HEAD").Trim();
        Git(remote, "checkout", "-q", "-b", "edit");
        var sourceFolder = Path.Combine(_root, "source", "Mod");

        WithUserGitConfig("clone.defaultRemoteName", "upstream", () =>
            TestAdapters.Source().CommitAtHead(sourceFolder, new SharedSource(remote, release), CancellationToken.None).Value());

        Assert.Equal(release, Git(sourceFolder, "rev-parse", "main").Trim());
    }

    private static void WithUserGitConfig(string key, string value, Action body)
    {
        string[] variables = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
        var previous = variables.Select(Environment.GetEnvironmentVariable).ToArray();
        try
        {
            Environment.SetEnvironmentVariable("GIT_CONFIG_COUNT", "1");
            Environment.SetEnvironmentVariable("GIT_CONFIG_KEY_0", key);
            Environment.SetEnvironmentVariable("GIT_CONFIG_VALUE_0", value);
            body();
        }
        finally
        {
            foreach (var (variable, was) in variables.Zip(previous)) Environment.SetEnvironmentVariable(variable, was);
        }
    }

    private static string Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
}
