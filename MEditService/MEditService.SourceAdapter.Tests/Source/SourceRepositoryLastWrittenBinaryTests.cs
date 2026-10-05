using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLastWrittenBinaryTests
{
    private static readonly PluginAddress Test = new("Test.esp", "TestMod");
    private static readonly PluginAddress Other = new("Other.esp", "TestMod");

    private const string OthersTrackedBinary = "TRACKED-FOR-OTHER";

    private static SourceRepository TrackedOver(ScratchDirectory modFolder)
    {
        SourceRepository.Track(
            modFolder, SourcePreset.Edits,
            [
                ([new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())],
                    new BaselineTrailers("Test.esp", null, null)),
                ([new TreeFile("plugin-source/Other.esp/npc_/Other.esp/000002.json", "{}"u8.ToArray())],
                    new BaselineTrailers("Other.esp", null, OthersTrackedBinary)),
            ]);
        return SourceRepository.Over(modFolder, GameRelease.Fallout4);
    }

    [Fact]
    public void TheLastWrittenBinary_IsWhatTheWriteRecorded_OnceTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);

        repository.WriteBinary(Test, "DEADBEEF1234", () => { });

        Assert.Equal(["DEADBEEF1234"], repository.LastWrittenBinarySha256s(Test));
    }

    [Fact]
    public void TheLastWrittenBinaries_NameTheNewBinaryBesideTheOldOne_UntilTheWriteReturns()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { });

        IReadOnlyList<string>? during = null;
        repository.WriteBinary(Test, "SECOND", () => during = repository.LastWrittenBinarySha256s(Test));

        Assert.Equal(["SECOND", "FIRST"], during);
        Assert.Equal(["SECOND"], repository.LastWrittenBinarySha256s(Test));
    }

    [Fact]
    public void TheLastWrittenBinaries_StayNamingTheOldAndTheNewBinary_WhenTheWriteFails()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);
        repository.WriteBinary(Test, "FIRST", () => { });

        Assert.Throws<IOException>(() => repository.WriteBinary(Test, "SECOND", () => throw new IOException("disk full")));

        Assert.Equal(["SECOND", "FIRST"], repository.LastWrittenBinarySha256s(Test));
    }

    [Fact]
    public void ThePluginsOfOneTrack_AnswerOnlyTheirOwnBinaries()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);

        repository.WriteBinary(Test, "FOR-TEST", () => { });

        Assert.Equal(["FOR-TEST"], repository.LastWrittenBinarySha256s(Test));
        Assert.Equal([OthersTrackedBinary], repository.LastWrittenBinarySha256s(Other));
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmptyNotAThrow_ForAPluginNothingWasRecordedFor()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        var repository = TrackedOver(modFolder);

        Assert.Empty(repository.LastWrittenBinarySha256s(new PluginAddress("Unknown.esp", "TestMod")));
    }

    [Fact]
    public void TheLastWrittenBinaries_AreEmpty_ForAnUntrackedFolder()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");

        Assert.Empty(SourceRepository.Over(modFolder, GameRelease.Fallout4).LastWrittenBinarySha256s(Test));
    }

    [Fact]
    public void ARepositoryOpenedForAMod_RefusesToWriteTheRecordOfAPluginAnotherModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = SourceRepository.Over(new PluginProvider.FromMod("TestMod", modFolder), GameRelease.Fallout4);

        Assert.Throws<ArgumentException>(() => repository.WriteBinary(new PluginAddress("Test.esp", "OtherMod"), "ABC", () => { }));
        Assert.Empty(repository.LastWrittenBinarySha256s(Test));
    }

    [Fact]
    public void ARepositoryOpenedForAMod_RefusesToReadTheRecordOfAPluginAnotherModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = SourceRepository.Over(new PluginProvider.FromMod("TestMod", modFolder), GameRelease.Fallout4);

        Assert.Throws<ArgumentException>(() => repository.LastWrittenBinarySha256s(new PluginAddress("Test.esp", "OtherMod")));
    }

    [Fact]
    public void ARepositoryOpenedForAMod_AnswersThePluginsThatModProvides()
    {
        using var modFolder = new ScratchDirectory("medit-last-written-");
        TrackedOver(modFolder);
        var repository = SourceRepository.Over(new PluginProvider.FromMod("TESTMOD", modFolder), GameRelease.Fallout4);

        repository.WriteBinary(Test, "ABC", () => { });

        Assert.Equal(["ABC"], repository.LastWrittenBinarySha256s(Test));
    }
}
