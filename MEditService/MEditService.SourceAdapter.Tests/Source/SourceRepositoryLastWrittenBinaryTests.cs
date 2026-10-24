using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLastWrittenBinaryTests
{
    private static readonly PluginAddress Test = new("Test.esp", "TestMod");
    private static readonly PluginAddress Other = new("Other.esp", "TestMod");

    private const string OthersSourceModBinary = "SOURCE_MOD-FOR-OTHER";

    private static ISourceRepository SourceModOver(ScratchDirectory modFolder)
    {
        Assert.Null(TestAdapters.Source().Init(
            modFolder, [PluginBaselines.OneRecordOf("Test.esp"), PluginBaselines.OneRecordOf("Other.esp", OthersSourceModBinary)]));
        return TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4);
    }

    [Fact]
    public void TheLastWrittenBinary_IsWhatTheWriteRecorded_OnceTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);

        repository.WriteBinary(Test, "DEADBEEF1234", () => { }).Value();

        Assert.Equal(["DEADBEEF1234"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_NameTheNewBinaryBesideTheOldOne_UntilTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();

        IReadOnlyList<string>? during = null;
        repository.WriteBinary(Test, "SECOND", () => during = repository.LastWrittenBinarySha256s(Test).Value()).Value();

        Assert.Equal(["SECOND", "FIRST"], during);
        Assert.Equal(["SECOND"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_StayNamingTheOldAndTheNewBinary_WhenTheWriteFails()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();

        Assert.IsType<SourceFailure.Inaccessible>(repository.WriteBinary(Test, "SECOND", () => throw new IOException("disk full")).Stopped());

        Assert.Equal(["SECOND", "FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void AGitFailureAfterTheWrite_ReportsTheRecordUnfinished_AndTheBinaryStaysWritten()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();
        var written = false;

        var recorded = repository.WriteBinary(Test, "SECOND", () =>
        {
            written = true;
            GitHooks.RefuseRefUpdates(modFolder);
        }).Value();

        Assert.False(recorded);
        Assert.True(written);
        Assert.Equal(["SECOND", "FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void AGitFailureBeforeTheWrite_AnswersItAndNeverWrites()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();
        GitHooks.RefuseRefUpdates(modFolder);
        var written = false;

        var failure = Assert.IsType<SourceFailure.GitFailed>(repository.WriteBinary(Test, "SECOND", () => written = true).Stopped());

        Assert.False(written);
        Assert.DoesNotContain(modFolder, failure.Reason, StringComparison.Ordinal);
        Assert.Equal(["FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ThePluginsOfOneInit_AnswerOnlyTheirOwnBinaries()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);
        Assert.Empty(repository.LastWrittenBinarySha256s(Test).Value());

        repository.WriteBinary(Test, "FOR-TEST", () => { }).Value();

        Assert.Equal(["FOR-TEST"], repository.LastWrittenBinarySha256s(Test).Value());
        Assert.Equal([OthersSourceModBinary], repository.LastWrittenBinarySha256s(Other).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmptyNotAThrow_ForAPluginNothingWasRecordedFor()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = SourceModOver(modFolder);

        Assert.Empty(repository.LastWrittenBinarySha256s(new PluginAddress("Unknown.esp", "TestMod")).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmpty_ForANonSourceModFolder()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");

        Assert.Empty(TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4).LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ARepositoryOpenedForAMod_AnswersThePluginsOfThatMod_ItsNameComparedWithoutCase()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        SourceModOver(modFolder);
        var repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("TESTMOD", modFolder, modFolder), GameRelease.Fallout4);

        repository.WriteBinary(Test, "ABC", () => { }).Value();

        Assert.Equal(["ABC"], repository.LastWrittenBinarySha256s(Test).Value());
    }
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryLastWrittenBinaryWithoutGitTests : IDisposable
{
    private readonly ScratchDirectory _modFolder = new("medit-last-written-nogit-");

    public SourceRepositoryLastWrittenBinaryWithoutGitTests() =>
        PluginBaselines.Init(_modFolder, [new TreeFile("plugin-source/A.esp/npc_/A.esp/000001.json", "{}"u8.ToArray())]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void TheLastWrittenBinaries_WithGitGoneFromPath_AnswerGitUnavailable()
    {
        var repository = TestAdapters.Source().OverFolder(TestMod.In(_modFolder), GameRelease.Fallout4);

        var answer = GitOffPath.While(() => repository.LastWrittenBinarySha256s(new PluginAddress("A.esp", TestMod.Name)));

        Assert.IsType<SourceFailure.GitUnavailable>(answer.Stopped());
    }
}
