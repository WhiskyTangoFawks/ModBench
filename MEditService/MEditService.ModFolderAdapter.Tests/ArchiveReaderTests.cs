using System.Text;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ArchiveReaderTests : IDisposable
{
    private readonly ScratchDirectory _scratch = new("archive-reader-");

    public void Dispose() => _scratch.Dispose();

    public static TheoryData<string, GameRelease> Variants => new()
    {
        { "ba2", GameRelease.Fallout4 },
        { "bsa", GameRelease.SkyrimSE },
    };

    private static IArchiveVariant VariantNamed(string format) =>
        format == "ba2" ? new Ba2Variant(1, Ba2Contents.General, Compressed: true) : new BsaVariant(105, ArchiveFlags: 0x3, FileFlags: 0x3);

    [Theory]
    [MemberData(nameof(Variants))]
    public void AnArchive_HoldsEachFileByItsForwardSlashPath(string format, GameRelease release)
    {
        ArchiveFile[] files =
        [
            new("meshes/actors/a.nif", () => new MemoryStream(Encoding.ASCII.GetBytes("mesh"))),
            new("scripts/a.pex", () => new MemoryStream(Encoding.ASCII.GetBytes("script"))),
        ];
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(_scratch, $"Mod - Main.{format}", files, VariantNamed(format)));
        var archive = Path.Combine(_scratch, $"Mod - Main.{format}");

        var contents = ArchiveReader.Contents(release, archive);

        Assert.Equal((archive, (string?)null), (contents.Archive, contents.Unreadable));
        Assert.Equal(["meshes/actors/a.nif", "scripts/a.pex"], contents.Files.Order(StringComparer.OrdinalIgnoreCase));
    }

    [Fact]
    public void AFileThatIsNoArchive_HoldsNothing_AndSaysWhy()
    {
        var archive = Path.Combine(_scratch, "Mod - Main.ba2");
        File.WriteAllText(archive, "BTDX but nothing after it");

        var contents = ArchiveReader.Contents(GameRelease.Fallout4, archive);

        Assert.Empty(contents.Files);
        Assert.False(string.IsNullOrWhiteSpace(contents.Unreadable));
    }
}
