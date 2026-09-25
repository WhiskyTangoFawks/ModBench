using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryParkedCompileBinarySha256Tests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-parked-sha-").FullName;

    [Fact]
    public void ParkedCompileBinarySha256_ReadsBackWhatParkCompileSnapshotWrote()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            PluginBaselines.Track(modFolder, SourcePreset.Edits, files);

            SourceRepository.ParkCompileSnapshot(modFolder, "Test.esp", atRef: null, binarySha256: "DEADBEEF1234");

            Assert.Equal("DEADBEEF1234", SourceRepository.ParkedCompileBinarySha256(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkedCompileBinarySha256_IsNull_WhenTheRefDoesNotExist()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            // Track parks a ref only for the plugins it tracks, which leaves "Other.esp" with none: the
            // orphaned-ref case must degrade, never throw.
            PluginBaselines.Track(modFolder, SourcePreset.Edits, files);

            Assert.Null(SourceRepository.ParkedCompileBinarySha256(modFolder, "Other.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkedCompileBinarySha256_IsNull_ForAnUntrackedFolder()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Null(SourceRepository.ParkedCompileBinarySha256(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
