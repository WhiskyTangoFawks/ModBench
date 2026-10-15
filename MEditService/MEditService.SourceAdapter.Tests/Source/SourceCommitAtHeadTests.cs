using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceCommitAtHeadTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-source-commit-at-head-");
    private readonly string _remote;
    private readonly Dictionary<string, string> _commits = [];

    public SourceCommitAtHeadTests()
    {
        _remote = Directory.CreateDirectory(Path.Combine(_root, "remote")).FullName;
        Git(_remote, "init", "-q", "-b", "main");
        Commit("first");
        Commit("second");
    }

    public void Dispose() => _root.Dispose();

    private string SourceFolder => Path.Combine(_root, "source", "Mod");

    [Theory]
    [InlineData("first")]
    [InlineData("second")]
    public void AnAbsentSource_IsClonedFromItsRemote_AtTheCommit(string at)
    {
        Assert.Equal(_commits[at], CommitAtHead(_remote, _commits[at]).Value());

        Assert.Equal(_commits[at], Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(at, File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
    }

    [Theory]
    [InlineData("core.autocrlf", "false")]
    [InlineData("core.longpaths", "true")]
    [InlineData("core.quotePath", "false")]
    [InlineData("commit.gpgsign", "false")]
    [InlineData("gc.autoDetach", "false")]
    public void AClone_IsSetAsInitSetsARepository(string key, string value)
    {
        CommitAtHead(_remote, _commits["second"]).Value();

        Assert.Equal(value, Git(SourceFolder, "config", "--local", "--get", key).Trim());
    }

    [Fact]
    public void AClone_OfARemoteWhoseDefaultBranchIsNotMain_HasTheRemotesMain()
    {
        Git(_remote, "checkout", "-q", "-b", "edit", _commits["second"]);
        Git(_remote, "branch", "-f", "main", _commits["first"]);

        CommitAtHead(_remote, _commits["second"]).Value();

        Assert.Equal(_commits["first"], Git(SourceFolder, "rev-parse", "main").Trim());
        Assert.True(TestAdapters.Source().IsTracked(SourceFolder));
    }

    [Fact]
    public void AClone_OfARemoteWithNoMain_IsRefused_LeavingNoFolder()
    {
        Git(_remote, "branch", "-m", "main", "trunk");

        var failure = CommitAtHead(_remote, _commits["second"]).Stopped();

        Assert.Equal("its remote has no main, so it is not a source mod's repository", failure.Reason);
        Assert.False(Directory.Exists(SourceFolder));
    }

    [Fact]
    public void ASourceAtAnotherCommit_AnswersThatCommit_AndIsNotMoved()
    {
        CommitAtHead(_remote, _commits["first"]).Value();

        Assert.Equal(_commits["first"], CommitAtHead(_remote, _commits["second"]).Value());

        Assert.Equal("first", File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
    }

    [Theory]
    [InlineData("a commit its remote does not hold", "remote", "0123456789012345678901234567890123456789")]
    [InlineData("a remote that is not there", "gone", "second")]
    public void ACloneThatCannotReachTheCommit_Fails_LeavingNoFolder(string cause, string remote, string commit)
    {
        var failure = CommitAtHead(Path.Combine(_root, remote), _commits.GetValueOrDefault(commit, commit)).Stopped();

        Assert.True(failure is SourceFailure.GitFailed, cause);
        Assert.False(Directory.Exists(SourceFolder), cause);
    }

    [Fact]
    public void ARemoteThatReadsAsAnOption_IsRefused_RunningNothing()
    {
        var failure = CommitAtHead("--upload-pack=touch medit-owned", _commits["second"]).Stopped();

        Assert.Equal("its remote '--upload-pack=touch medit-owned' is not a remote git can clone", failure.Reason);
        Assert.False(Directory.Exists(SourceFolder));
    }

    [PosixFact]
    public async Task ACloneCancelledWhileGitWaits_StopsGit_LeavingNoFolder()
    {
        var stalled = Directory.CreateDirectory(Path.Combine(_root, "stalled", ".git")).FullName;
        using (var fifo = System.Diagnostics.Process.Start("mkfifo", Path.Combine(stalled, "HEAD"))) await fifo.WaitForExitAsync();
        using var cancelling = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        var failure = await Task.Run(() => CommitAtHead(Path.Combine(_root, "stalled"), _commits["second"], cancelling.Token).Stopped())
            .WaitAsync(TimeSpan.FromSeconds(60));

        Assert.Equal("the clone was cancelled", failure.Reason);
        Assert.False(Directory.Exists(SourceFolder));
    }

    [Fact]
    public void AFolderThatHoldsNoRepository_IsUnreadable_NamingIt()
    {
        Directory.CreateDirectory(SourceFolder);

        var failure = CommitAtHead(_remote, _commits["first"]).Stopped();

        Assert.Equal($"'{SourceFolder}' holds no repository.", Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private RepositoriesLib.Answer<string, SourceFailure> CommitAtHead(string remote, string commit, CancellationToken cancel = default) =>
        TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(remote, commit), cancel);

    private void Commit(string text)
    {
        File.WriteAllText(Path.Combine(_remote, "build.json"), text);
        Git(_remote, "add", "-A");
        Git(_remote, "commit", "-q", "-m", text);
        _commits[text] = Git(_remote, "rev-parse", "HEAD").Trim();
    }

    private static string Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
}
