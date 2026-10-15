using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceCommitAtHeadTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-source-commit-at-head-");
    private readonly string _remote;
    private readonly string _first;
    private readonly string _second;

    public SourceCommitAtHeadTests()
    {
        _remote = Directory.CreateDirectory(Path.Combine(_root, "remote")).FullName;
        Git(_remote, "init", "-q", "-b", "main");
        _first = Commit("first");
        _second = Commit("second");
    }

    public void Dispose() => _root.Dispose();

    private string SourceFolder => Path.Combine(_root, "source", "Mod");

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AnAbsentSource_IsClonedFromItsRemote_AtTheCommit(bool atTheTip)
    {
        var commit = atTheTip ? _second : _first;

        Assert.Equal(commit, TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(_remote, commit)).Value());

        Assert.Equal(commit, Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(atTheTip ? "second" : "first", File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
    }

    [Fact]
    public void ASourceAtAnotherCommit_AnswersThatCommit_AndIsNotMoved()
    {
        TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(_remote, _first)).Value();

        Assert.Equal(_first, TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(_remote, _second)).Value());

        Assert.Equal("first", File.ReadAllText(Path.Combine(SourceFolder, "build.json")));
    }

    [Theory]
    [InlineData("a commit its remote does not hold", "remote", "0123456789012345678901234567890123456789")]
    [InlineData("a remote that is not there", "gone", null)]
    public void ACloneThatCannotReachTheCommit_Fails_LeavingNoFolder(string cause, string remote, string? commit)
    {
        var failure = TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(Path.Combine(_root, remote), commit ?? _first)).Stopped();

        Assert.True(failure is SourceFailure.GitFailed, cause);
        Assert.False(Directory.Exists(SourceFolder), cause);
    }

    [Fact]
    public void AFolderThatHoldsNoRepository_IsUnreadable_NamingIt()
    {
        Directory.CreateDirectory(SourceFolder);

        var failure = TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(_remote, _first)).Stopped();

        Assert.Equal($"'{SourceFolder}' holds no repository.", Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private string Commit(string text)
    {
        File.WriteAllText(Path.Combine(_remote, "build.json"), text);
        Git(_remote, "add", "-A");
        Git(_remote, "commit", "-q", "-m", text);
        return Git(_remote, "rev-parse", "HEAD").Trim();
    }

    private static string Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
}
