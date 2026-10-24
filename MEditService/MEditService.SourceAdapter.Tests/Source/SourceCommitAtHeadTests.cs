using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceCommitAtHeadTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-source-commit-at-head-");
    private readonly PinnedSubmodule _submodule;
    private readonly Dictionary<string, string> _commits = [];

    public SourceCommitAtHeadTests()
    {
        _submodule = new PinnedSubmodule(_root);
        _commits["first"] = _submodule.Commit(("build.json", "first"));
        _commits["second"] = _submodule.Commit(("build.json", "second"));
    }

    public void Dispose()
    {
        _submodule.Dispose();
        _root.Dispose();
    }

    private string SourceFolder => _submodule.Folder;

    [Theory]
    [InlineData("first")]
    [InlineData("second")]
    public void AnAbsentSubmodule_IsCheckedOutByGitAtItsPin_AsASourceMod(string at)
    {
        Assert.Equal(new SubmoduleHead(_commits[at]), CommitAtHead(_commits[at]).Value());

        Assert.Equal(_commits[at], Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(at, File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
        Assert.True(TestAdapters.Source().IsSourceMod(SourceFolder));
    }

    [Fact]
    public void ASubmoduleFolderACloneLeftEmpty_IsCheckedOutByGitAtItsPin_AsASourceMod()
    {
        Directory.CreateDirectory(SourceFolder);

        Assert.Equal(new SubmoduleHead(_commits["first"]), CommitAtHead(_commits["first"]).Value());

        Assert.Equal(_commits["first"], Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.True(TestAdapters.Source().IsSourceMod(SourceFolder));
    }

    [Theory]
    [InlineData("core.autocrlf", "false")]
    [InlineData("core.longpaths", "true")]
    [InlineData("core.quotePath", "false")]
    [InlineData("commit.gpgsign", "false")]
    [InlineData("gc.autoDetach", "false")]
    public void AClone_IsSetAsInitSetsARepository(string key, string value)
    {
        CommitAtHead(_commits["second"]).Value();

        Assert.Equal(value, Git(SourceFolder, "config", "--local", "--get", key).Trim());
    }

    [Theory]
    [InlineData("second", "main")]
    [InlineData("first", "HEAD")]
    public void AClone_LandsOnTheBranchItFollows_OnlyWhenThatBranchIsAtThePin(string pinned, string landsOn)
    {
        _submodule.Follow("main");

        var head = CommitAtHead(_commits[pinned]).Value();

        Assert.Equal((new SubmoduleHead(_commits[pinned]), landsOn), (head, Branch()));
    }

    [Fact]
    public void AClone_IntoAGitDirectoryADeinitKept_LeavesTheBranchItHolds_AndSaysItIsLeftDetachedAtThePin()
    {
        _submodule.Follow("main");
        CommitAtHead(_commits["second"]).Value();
        Git(SourceFolder, "commit", "-q", "--allow-empty", "-m", "unpushed");
        var unpushed = Git(SourceFolder, "rev-parse", "main").Trim();
        Git(_submodule.Instance, "submodule", "deinit", "-q", "-f", "--", "source/Mod");

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal(
            (new SubmoduleHead(_commits["second"], $"its branch 'main' is at {unpushed}, not at the pin, so it is left detached at the pin"), "HEAD", unpushed),
            (head, Git(SourceFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim(), Git(SourceFolder, "rev-parse", "main").Trim()));
    }

    [Fact]
    public void APresentSubmoduleDetachedAtThePin_LandsOnTheLocalBranchItFollows_WhenThatBranchIsAtThePin()
    {
        ClonedThenDetached();

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal((new SubmoduleHead(_commits["second"]), "main"), (head, Branch()));
    }

    [Fact]
    public void APresentSubmoduleDetachedAtThePin_LandsOnANewBranchTrackingOrigin_WhenNoLocalBranchExists()
    {
        ClonedThenDetached();
        Git(SourceFolder, "branch", "-q", "-D", "main");

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal((new SubmoduleHead(_commits["second"]), "main", "origin"), (head, Branch(), Git(SourceFolder, "config", "branch.main.remote").Trim()));
    }

    [Fact]
    public void APresentSubmoduleDetachedAtThePin_StaysDetached_AndNamesTheBranch_WhenThatBranchIsAtAnotherCommit()
    {
        ClonedThenDetached();
        Git(SourceFolder, "branch", "-q", "-f", "main", _commits["first"]);

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal(
            (new SubmoduleHead(_commits["second"], $"its branch 'main' is at {_commits["first"]}, not at the pin, so it is left detached at the pin"), "HEAD", _commits["first"]),
            (head, Branch(), Git(SourceFolder, "rev-parse", "main").Trim()));
    }

    [Fact]
    public void APresentSubmoduleDetachedAtThePin_StaysDetached_AndSaysWhy_WhenGitCannotCheckOutTheBranch()
    {
        ClonedThenDetached();
        Git(SourceFolder, "worktree", "add", "-q", Path.Combine(_root, "elsewhere"), "main");

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal(
            (new SubmoduleHead(_commits["second"], "its branch 'main' could not be checked out (git checkout failed (128)), so it is left detached at the pin"), "HEAD"),
            (head, Branch()));
    }

    [Fact]
    public void APresentSubmoduleDetachedAtThePin_NamesItsBranch_WhenThatBranchIsTheRemotesAndAheadOfThePin()
    {
        ClonedThenDetached();
        Git(SourceFolder, "checkout", "-q", "--detach", _commits["first"]);

        var head = CommitAtHead(_commits["first"]).Value();

        Assert.Equal(
            (new SubmoduleHead(_commits["first"], $"its branch 'main' is at {_commits["second"]}, not at the pin, so it is left detached at the pin"), "HEAD"),
            (head, Branch()));
    }

    [Fact]
    public void APresentSubmoduleOnABranchAtThePin_IsLeftOnIt()
    {
        _submodule.Follow("main");
        CommitAtHead(_commits["second"]).Value();
        Git(SourceFolder, "checkout", "-q", "-b", "side");

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal((new SubmoduleHead(_commits["second"]), "side"), (head, Branch()));
    }

    [Fact]
    public void APresentSubmoduleAtAnotherCommit_IsNotLandedOnTheBranchItFollows()
    {
        _submodule.Follow("main");
        CommitAtHead(_commits["second"]).Value();
        Git(SourceFolder, "checkout", "-q", "--detach", _commits["first"]);

        var head = CommitAtHead(_commits["second"]).Value();

        Assert.Equal((new SubmoduleHead(_commits["first"]), "HEAD"), (head, Branch()));
    }

    private void ClonedThenDetached()
    {
        _submodule.Follow("main");
        CommitAtHead(_commits["second"]).Value();
        Git(SourceFolder, "checkout", "-q", "--detach");
    }

    private string Branch() => Git(SourceFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim();

    [Fact]
    public void APinItsRemoteLacked_IsClonedByARetry_OnceItsRemoteHoldsIt()
    {
        var developer = Directory.CreateDirectory(Path.Combine(_root, "developer")).FullName;
        Git(developer, "init", "-q", "-b", "main");
        Git(developer, "fetch", "-q", _submodule.Remote, "main");
        Git(developer, "reset", "-q", "--hard", "FETCH_HEAD");
        Git(developer, "commit", "-q", "--allow-empty", "-m", "third");
        var third = Git(developer, "rev-parse", "HEAD").Trim();
        var failed = CommitAtHead(third).Stopped();
        Git(developer, "push", "-q", _submodule.Remote, "HEAD:refs/heads/side");

        Assert.Equal((typeof(SourceFailure.GitFailed), third), (failed.GetType(), CommitAtHead(third).Value().Commit));
    }

    [Fact]
    public void AGitDirectoryAKilledCloneLeftBeforeItsFetch_IsFetchedByARetry()
    {
        var modules = Directory.CreateDirectory(Path.Combine(_submodule.Instance, ".git", "modules", "Mod")).FullName;
        Directory.CreateDirectory(SourceFolder);
        GitProbe.Run(modules, SourceFolder, "init", "-q");
        GitProbe.Run(modules, SourceFolder, "config", "remote.origin.url", _submodule.Remote);
        GitProbe.Run(modules, SourceFolder, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");

        Assert.Equal(_commits["second"], CommitAtHead(_commits["second"]).Value().Commit);
    }

    [Fact]
    public void AClone_OfARemoteWhoseDefaultBranchIsNotMain_HasTheRemotesMain()
    {
        Git(_submodule.Remote, "checkout", "-q", "-b", "edit", _commits["second"]);
        Git(_submodule.Remote, "branch", "-f", "main", _commits["first"]);

        CommitAtHead(_commits["second"]).Value();

        Assert.Equal(_commits["first"], Git(SourceFolder, "rev-parse", "main").Trim());
        Assert.True(TestAdapters.Source().IsSourceMod(SourceFolder));
    }

    [Fact]
    public void AClone_OfARemoteWithNoMain_IsRefused_LeavingTheFolderHoldingNothing()
    {
        Git(_submodule.Remote, "branch", "-m", "main", "trunk");

        var failure = CommitAtHead(_commits["second"]).Stopped();

        Assert.Equal("its remote has no main, so it is not a source mod's repository", failure.Reason);
        Assert.Empty(Directory.EnumerateFileSystemEntries(SourceFolder));
    }

    [Fact]
    public void ASubmoduleAtAnotherCommit_AnswersThatCommit_AndIsNotMoved()
    {
        CommitAtHead(_commits["first"]).Value();

        Assert.Equal(_commits["first"], CommitAtHead(_commits["second"]).Value().Commit);

        Assert.Equal("first", File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
    }

    [Fact]
    public void APinItsRemoteDoesNotHold_Fails_NamingThePin_LeavingTheFolderHoldingNothing()
    {
        const string Unpushed = "0123456789012345678901234567890123456789";

        var failure = CommitAtHead(Unpushed).Stopped();

        Assert.Equal($"its remote holds no commit {Unpushed}", Assert.IsType<SourceFailure.GitFailed>(failure).Reason);
        Assert.Empty(Directory.EnumerateFileSystemEntries(SourceFolder));
    }

    [Fact]
    public void ARemoteThatIsNotThere_Fails_LeavingTheFolderHoldingNothing()
    {
        Git(_submodule.Instance, "config", "-f", ".gitmodules", "submodule.Mod.url", Path.Combine(_root, "gone"));

        var failure = CommitAtHead(_commits["second"]).Stopped();

        Assert.Equal("git submodule failed (1)", Assert.IsType<SourceFailure.GitFailed>(failure).Reason);
        Assert.False(Directory.Exists(SourceFolder) && Directory.EnumerateFileSystemEntries(SourceFolder).Any());
    }

    [PosixFact]
    public async Task ACloneCancelledWhileGitWaits_StopsGit_LeavingTheFolderHoldingNothing()
    {
        var stalled = Directory.CreateDirectory(Path.Combine(_root, "stalled", ".git")).FullName;
        using (var fifo = System.Diagnostics.Process.Start("mkfifo", Path.Combine(stalled, "HEAD"))) await fifo.WaitForExitAsync();
        Git(_submodule.Instance, "config", "-f", ".gitmodules", "submodule.Mod.url", Path.Combine(_root, "stalled"));
        using var cancelling = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        var failure = await Task.Run(() => CommitAtHead(_commits["second"], cancelling.Token).Stopped())
            .WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal("the clone was cancelled", failure.Reason);
        Assert.False(Directory.Exists(SourceFolder) && Directory.EnumerateFileSystemEntries(SourceFolder).Any());
    }

    [Fact]
    public void AFolderThatHoldsFilesButNoRepository_IsUnreadable_NamingIt()
    {
        Directory.CreateDirectory(SourceFolder);
        File.WriteAllText(Path.Combine(SourceFolder, "notes.txt"), "mine");

        var failure = CommitAtHead(_commits["first"]).Stopped();

        Assert.Equal($"'{SourceFolder}' holds no repository.", Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private RepositoriesLib.Answer<SubmoduleHead, SourceFailure> CommitAtHead(string pin, CancellationToken cancel = default)
    {
        _submodule.Pin(pin);
        return TestAdapters.Source().CommitAtHead(new Submodule(SourceFolder, pin, _submodule.Branch), cancel);
    }

    private static string Git(string folder, params string[] args) => PinnedSubmodule.Git(folder, args);
}
