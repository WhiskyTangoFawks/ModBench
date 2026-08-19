using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #414/ADR-0041 AC: deleting <c>.git</c> makes the mod read as untracked again — with no residue,
/// no registry, no sweep. Ledger text is ordinary working-tree content once <c>.git</c> is gone;
/// nothing in this module is notified of, or reacts to, the deletion (never-assume-exclusive-
/// ownership).
/// </summary>
public sealed class LedgerRepositoryUntrackTests
{
    [Fact]
    public void DeletingGit_MakesIsTrackedFalseAgain_WithLedgerFilesUntouched()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-untrack-").FullName;
        try
        {
            var relativePath = Path.Combine("Test.esp.ledger", "npc_", "Test.esp", "000001.json");
            var content = "{\"formKey\":\"000001:Test.esp\"}"u8.ToArray();
            LedgerRepository.Track(
                modFolder, LedgerPreset.Edits,
                [new PristineFile(relativePath, content)],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            var ledgerFilePath = Path.Combine(modFolder, relativePath);
            Assert.True(LedgerRepository.IsTracked(modFolder));
            // Positive control, checked before the deletion, through the identical File.Exists +
            // File.ReadAllBytes query the post-deletion assertions below reuse — proves the file
            // really is there (and has these exact bytes) before claiming it survives.
            Assert.True(File.Exists(ledgerFilePath));
            Assert.Equal(content, File.ReadAllBytes(ledgerFilePath));

            Directory.Delete(Path.Combine(modFolder, ".git"), recursive: true);

            Assert.False(LedgerRepository.IsTracked(modFolder));
            Assert.True(File.Exists(ledgerFilePath), "the ledger text is not registry-backed and must survive .git's deletion");
            Assert.Equal(content, File.ReadAllBytes(ledgerFilePath));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
