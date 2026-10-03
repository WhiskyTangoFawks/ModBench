using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryParkedCompileBinarySha256sTests
{
    private static TreeFile[] TestEspFiles() => [new("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())];

    [Fact]
    public void ParkedCompileBinarySha256s_ReadBackWhatParkCompileSnapshotWrote()
    {
        using var modFolder = new ScratchDirectory("medit-parked-sha-");
        PluginBaselines.Track(modFolder, SourcePreset.Edits, TestEspFiles());

        SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "DEADBEEF1234");

        Assert.Equal(["DEADBEEF1234"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
    }

    [Fact]
    public void ParkedCompileBinarySha256s_NameEveryParkedBinary_UntilTheSnapshotIsNarrowed()
    {
        using var modFolder = new ScratchDirectory("medit-parked-sha-");
        PluginBaselines.Track(modFolder, SourcePreset.Edits, TestEspFiles());
        SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "FIRST");
        SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "SECOND");
        Assert.Equal(["SECOND", "FIRST"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));

        SourceRepository.NarrowCompileSnapshot(modFolder, "Test.esp");

        Assert.Equal(["SECOND"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
    }

    [Fact]
    public void ParkedCompileBinarySha256s_AreEmptyNotAThrow_ForAPluginTrackParkedNoRefFor()
    {
        using var modFolder = new ScratchDirectory("medit-parked-sha-");
        PluginBaselines.Track(modFolder, SourcePreset.Edits, TestEspFiles());

        Assert.Empty(SourceRepository.ParkedCompileBinarySha256s(modFolder, "Other.esp"));
    }

    [Fact]
    public void ParkedCompileBinarySha256s_AreEmpty_ForAnUntrackedFolder()
    {
        using var modFolder = new ScratchDirectory("medit-parked-sha-");

        Assert.Empty(SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
    }
}
