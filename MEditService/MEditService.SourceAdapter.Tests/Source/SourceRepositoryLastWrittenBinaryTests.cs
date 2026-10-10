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

    private const string OthersTrackedBinary = "TRACKED-FOR-OTHER";

    private static ISourceRepository TrackedOver(ScratchDirectory modFolder)
    {
        TestAdapters.Source().Track(
            modFolder,
            [
                ([new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())],
                    new DecompiledPlugin("Test.esp", null)),
                ([new TreeFile("plugin-source/Other.esp/npc_/Other.esp/000002.json", "{}"u8.ToArray())],
                    new DecompiledPlugin("Other.esp", OthersTrackedBinary)),
            ]);
        return TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4);
    }

    [Fact]
    public void TheLastWrittenBinary_IsWhatTheWriteRecorded_OnceTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);

        repository.WriteBinary(Test, "DEADBEEF1234", () => { }).Value();

        Assert.Equal(["DEADBEEF1234"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_NameTheNewBinaryBesideTheOldOne_UntilTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
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
        var repository = TrackedOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();

        Assert.IsType<SourceFailure.Inaccessible>(repository.WriteBinary(Test, "SECOND", () => throw new IOException("disk full")).Stopped());

        Assert.Equal(["SECOND", "FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void AGitFailureAfterTheWrite_ReportsTheRecordUnfinished_AndTheBinaryStaysWritten()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();
        var written = false;

        var recorded = repository.WriteBinary(Test, "SECOND", () =>
        {
            written = true;
            LastWriteRecord.RefuseRefUpdates(modFolder);
        }).Value();

        Assert.False(recorded);
        Assert.True(written);
        Assert.Equal(["SECOND", "FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void AGitFailureBeforeTheWrite_AnswersItAndNeverWrites()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { }).Value();
        LastWriteRecord.RefuseRefUpdates(modFolder);
        var written = false;

        var failure = Assert.IsType<SourceFailure.GitFailed>(repository.WriteBinary(Test, "SECOND", () => written = true).Stopped());

        Assert.False(written);
        Assert.DoesNotContain(modFolder, failure.Reason, StringComparison.Ordinal);
        Assert.Equal(["FIRST"], repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ThePluginsOfOneTrack_AnswerOnlyTheirOwnBinaries()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
        Assert.Empty(repository.LastWrittenBinarySha256s(Test).Value());

        repository.WriteBinary(Test, "FOR-TEST", () => { }).Value();

        Assert.Equal(["FOR-TEST"], repository.LastWrittenBinarySha256s(Test).Value());
        Assert.Equal([OthersTrackedBinary], repository.LastWrittenBinarySha256s(Other).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmptyNotAThrow_ForAPluginNothingWasRecordedFor()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);

        Assert.Empty(repository.LastWrittenBinarySha256s(new PluginAddress("Unknown.esp", "TestMod")).Value());
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmpty_ForAnUntrackedFolder()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");

        Assert.Empty(TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4).LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ARepositoryOpenedForAMod_RefusesToWriteTheRecordOfAPluginAnotherModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("TestMod", modFolder), GameRelease.Fallout4);

        Assert.Throws<ArgumentException>(() => repository.WriteBinary(new PluginAddress("Test.esp", "OtherMod"), "ABC", () => { }).Value());
        Assert.Empty(repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ARepositoryOpenedForAMod_RefusesToReadTheRecordOfAPluginAnotherModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("TestMod", modFolder), GameRelease.Fallout4);

        Assert.Throws<ArgumentException>(() => repository.LastWrittenBinarySha256s(new PluginAddress("Test.esp", "OtherMod")).Value());
    }

    [Fact]
    public void ARepositoryOpenedForAMod_RefusesToReplaceTheSourceOfAPluginAnotherModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("TestMod", modFolder), GameRelease.Fallout4);

        Assert.Throws<ArgumentException>(() => repository.ReplaceSourceFrom(new PluginAddress("Test.esp", "OtherMod"), [], "ABC"));
        Assert.Empty(repository.LastWrittenBinarySha256s(Test).Value());
    }

    [Fact]
    public void ARepositoryOpenedForAMod_AnswersThePluginsThatModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("TESTMOD", modFolder), GameRelease.Fallout4);

        repository.WriteBinary(Test, "ABC", () => { }).Value();

        Assert.Equal(["ABC"], repository.LastWrittenBinarySha256s(Test).Value());
    }
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryLastWrittenBinaryWithoutGitTests : IDisposable
{
    private readonly ScratchDirectory _modFolder = new("medit-last-written-nogit-");

    public SourceRepositoryLastWrittenBinaryWithoutGitTests() =>
        PluginBaselines.Track(_modFolder, [new TreeFile("plugin-source/A.esp/npc_/A.esp/000001.json", "{}"u8.ToArray())]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void TheLastWrittenBinaries_WithGitGoneFromPath_AnswerGitUnavailable()
    {
        var repository = TestAdapters.Source().OverFolder(TestMod.In(_modFolder), GameRelease.Fallout4);
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            Assert.IsType<SourceFailure.GitUnavailable>(repository.LastWrittenBinarySha256s(new PluginAddress("A.esp", TestMod.Name)).Stopped());
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }

    [Fact]
    public void AWrite_AfterWhichGitIsGoneFromPath_AnswersTheRecordUnfinished_ForTheBinaryIsWritten()
    {
        var repository = TestAdapters.Source().OverFolder(TestMod.In(_modFolder), GameRelease.Fallout4);
        var path = Environment.GetEnvironmentVariable("PATH");
        try
        {
            var finished = repository.WriteBinary(
                new PluginAddress("A.esp", TestMod.Name), "SECOND", () => Environment.SetEnvironmentVariable("PATH", string.Empty));

            Assert.False(finished.Value());
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }
}
