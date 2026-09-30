using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryParkedCompileBinarySha256sTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-parked-sha-").FullName;

    [Fact]
    public void ParkedCompileBinarySha256s_ReadBackWhatParkCompileSnapshotWrote()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            PluginBaselines.Track(modFolder, SourcePreset.Edits, files);

            SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "DEADBEEF1234");

            Assert.Equal(["DEADBEEF1234"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkedCompileBinarySha256s_NameEveryParkedBinary_UntilTheSnapshotIsNarrowed()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            PluginBaselines.Track(modFolder, SourcePreset.Edits, files);
            SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "FIRST");
            SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", binarySha256: "SECOND");
            Assert.Equal(["SECOND", "FIRST"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));

            SourceRepository.NarrowCompileSnapshot(modFolder, "Test.esp");

            Assert.Equal(["SECOND"], SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkedCompileBinarySha256s_AreEmpty_WhenTheRefDoesNotExist()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            // Track parks a ref only for the plugins it tracks, which leaves "Other.esp" with none: the
            // orphaned-ref case must degrade, never throw.
            PluginBaselines.Track(modFolder, SourcePreset.Edits, files);

            Assert.Empty(SourceRepository.ParkedCompileBinarySha256s(modFolder, "Other.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkedCompileBinarySha256s_AreEmpty_ForAnUntrackedFolder()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Empty(SourceRepository.ParkedCompileBinarySha256s(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
