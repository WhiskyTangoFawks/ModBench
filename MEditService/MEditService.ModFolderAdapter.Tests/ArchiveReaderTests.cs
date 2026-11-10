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

    [Theory]
    [MemberData(nameof(Variants))]
    public void AFileOfAnArchive_IsItsBytes_AndAFileItLacksIsNone(string format, GameRelease release)
    {
        ArchiveFile[] files =
        [
            new("meshes/actors/a.nif", () => new MemoryStream(Encoding.ASCII.GetBytes("mesh"))),
            new("scripts/a.pex", () => new MemoryStream(Encoding.ASCII.GetBytes("script"))),
        ];
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(_scratch, $"Mod - Main.{format}", files, VariantNamed(format)));
        var archive = Path.Combine(_scratch, $"Mod - Main.{format}");

        Assert.Equal("script"u8.ToArray(), ArchiveReader.FileBytes(release, archive, "scripts/a.pex"));
        Assert.Null(ArchiveReader.FileBytes(release, archive, "scripts/missing.pex"));
    }

    private const string TheExtensionsDigestOfScript = "Zm84p1xofs8=";

    [Theory]
    [MemberData(nameof(Variants))]
    public void ACopyInAnArchive_IsItsSize_AndTheDigestALooseCopyOfItsBytesHasWhenAskedFor_AndAFileItLacksIsNone(string format, GameRelease release)
    {
        ArchiveFile[] files = [new("scripts/a.pex", () => new MemoryStream(Encoding.ASCII.GetBytes("script")))];
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(_scratch, $"Mod - Main.{format}", files, VariantNamed(format)));
        var archive = Path.Combine(_scratch, $"Mod - Main.{format}");

        var sized = ArchiveReader.Copies(release, archive, ["Scripts/A.pex", "scripts/missing.pex"], hashed: false);
        var hashed = ArchiveReader.Copies(release, archive, ["Scripts/A.pex"], hashed: true);

        Assert.Equal([new ArchivedCopy("Scripts/A.pex", 6, null)], sized);
        Assert.Equal([new ArchivedCopy("Scripts/A.pex", 6, TheExtensionsDigestOfScript)], hashed);
    }

    public static TheoryData<string, IArchiveVariant, GameRelease> EveryLayout => new()
    {
        { "ba2", new Ba2Variant(1, Ba2Contents.General, Compressed: true), GameRelease.Fallout4 },
        { "ba2", new Ba2Variant(1, Ba2Contents.General, Compressed: false), GameRelease.Fallout4 },
        { "ba2", new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), GameRelease.Fallout4 },
        { "bsa", new BsaVariant(105, ArchiveFlags: 0x3, FileFlags: 0x3), GameRelease.SkyrimSE },
    };

    [Theory]
    [MemberData(nameof(EveryLayout))]
    public void ACopysSize_ReadFromTheArchivesIndex_IsTheLengthOfItsBytes(string format, IArchiveVariant variant, GameRelease release)
    {
        var file = variant is Ba2Variant { Contents: Ba2Contents.Textures } ? "textures/a_d.dds" : "meshes/a.nif";
        var bytes = variant is Ba2Variant { Contents: Ba2Contents.Textures } ? Dds.Dxt1(width: 8, height: 8, mips: 2).File : Encoding.ASCII.GetBytes(new string('n', 4000));
        Assert.Null(new ArchivePacker(new ModFolderRepository()).Pack(_scratch, $"Mod - Main.{format}", [new ArchiveFile(file, () => new MemoryStream(bytes))], variant));
        var archive = Path.Combine(_scratch, $"Mod - Main.{format}");

        var copy = Assert.Single(ArchiveReader.Copies(release, archive, [file], hashed: false));

        Assert.Equal((long?)ArchiveReader.FileBytes(release, archive, file)?.Length, copy.Size);
    }
}
