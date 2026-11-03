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

        UserGitConfig.With("clone.defaultRemoteName", "upstream", () =>
            TestAdapters.Source().CommitAtHead(new Submodule(submodule.Folder, release, null), CancellationToken.None).Value());

        Assert.Equal(release, PinnedSubmodule.Git(submodule.Folder, "rev-parse", "main").Trim());
    }
}
