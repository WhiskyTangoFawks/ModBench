using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #417 B2: <see cref="LedgerRepository.ParkedCompileBinarySha256"/> — the read half of #416's
/// <see cref="LedgerRepository.ParkCompileSnapshot"/> trailer, and the exact value the self-echo
/// classifier compares an observed binary's hash against.
/// </summary>
public sealed class LedgerRepositoryParkedCompileBinarySha256Tests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-parked-sha-").FullName;

    [Fact]
    public void ParkedCompileBinarySha256_ReadsBackWhatParkCompileSnapshotWrote()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string> { ["Test.esp"] = "0000" }));

            LedgerRepository.ParkCompileSnapshot(modFolder, "Test.esp", atRef: null, binarySha256: "DEADBEEF1234");

            Assert.Equal("DEADBEEF1234", LedgerRepository.ParkedCompileBinarySha256(modFolder, "Test.esp"));
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
            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            // Track parks the ref only for plugins named in trailers.BinarySha256ByPlugin — an empty
            // dict here leaves "Other.esp" with no parked ref at all, the orphaned-ref case the
            // pinned decision says must degrade, never throw.
            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            Assert.Null(LedgerRepository.ParkedCompileBinarySha256(modFolder, "Other.esp"));
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
            Assert.Null(LedgerRepository.ParkedCompileBinarySha256(modFolder, "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
