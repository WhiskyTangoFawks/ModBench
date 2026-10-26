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
        using var submodule = new PinnedSubmodule(_root);
        var release = submodule.Commit(("readme.txt", "release"));
        PinnedSubmodule.Git(submodule.Remote, "checkout", "-q", "-b", "edit");
        submodule.Pin(release);

        WithUserGitConfig("clone.defaultRemoteName", "upstream", () =>
            TestAdapters.Source().CommitAtHead(new Submodule(submodule.Folder, release, null), CancellationToken.None).Value());

        Assert.Equal(release, PinnedSubmodule.Git(submodule.Folder, "rev-parse", "main").Trim());
    }

    private static void WithUserGitConfig(string key, string value, Action body)
    {
        var count = int.TryParse(Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT"), out var held) ? held : 0;
        string[] variables = ["GIT_CONFIG_COUNT", $"GIT_CONFIG_KEY_{count}", $"GIT_CONFIG_VALUE_{count}"];
        var previous = variables.Select(Environment.GetEnvironmentVariable).ToArray();
        try
        {
            Environment.SetEnvironmentVariable(variables[0], $"{count + 1}");
            Environment.SetEnvironmentVariable(variables[1], key);
            Environment.SetEnvironmentVariable(variables[2], value);
            body();
        }
        finally
        {
            foreach (var (variable, was) in variables.Zip(previous)) Environment.SetEnvironmentVariable(variable, was);
        }
    }
}
