using System.Buffers.Binary;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.Commands.Tests.Build;

public sealed class ArchivePackerTests : IDisposable
{
    private const string Mod = "mods/Mod";
    private const string Archive = "Mod - Main.archive";

    private static readonly byte[] Mesh = Encoding.ASCII.GetBytes(new string('n', 4000));
    private static readonly byte[] Script = Encoding.ASCII.GetBytes("Scriptname A");

    private readonly FakeModFolders _folders = new();
    private readonly ScratchDirectory _scratch = new("archive-packer-");

    public void Dispose() => _scratch.Dispose();

    private static readonly Ba2Variant Ba2 = new(1, Ba2Contents.General, Compressed: false);
    private static readonly BsaVariant Bsa104 = new(104, ArchiveFlags: 0x3, FileFlags: 0x3);

    private byte[] Pack(IArchiveVariant variant, params string[] files)
    {
        new ArchivePacker(_folders).Pack(Mod, files, Archive, variant);
        return _folders.Written[(Mod, Archive)];
    }

    private IArchiveReader Reader(GameRelease release, byte[] archive)
    {
        var path = System.IO.Path.Combine(_scratch, "read" + System.IO.Path.GetRandomFileName());
        File.WriteAllBytes(path, archive);
        return Mutagen.Bethesda.Archives.Archive.CreateReader(release, path);
    }

    private static Dictionary<string, byte[]> ContentsOf(IArchiveReader reader) =>
        reader.Files.ToDictionary(f => f.Path.Replace('/', '\\'), f => f.GetBytes());

    private FakeModFolders WithMeshAndScript() =>
        _folders.WithBytes(Mod, "Meshes/Actors/A.nif", Mesh).WithBytes(Mod, "scripts/a.pex", Script);

    [Fact]
    public void AGeneralBa2_HoldsEachFileUnderItsLowercasedBackslashPath()
    {
        WithMeshAndScript();

        var archive = Pack(Ba2, "Meshes/Actors/A.nif", "scripts/a.pex");

        var contents = ContentsOf(Reader(GameRelease.Fallout4, archive));
        Assert.Equal(["meshes\\actors\\a.nif", "scripts\\a.pex"], contents.Keys.Order());
        Assert.Equal(Mesh, contents["meshes\\actors\\a.nif"]);
        Assert.Equal(Script, contents["scripts\\a.pex"]);
    }

    [Fact]
    public void ACompressedGeneralBa2_IsSmallerAndReadsBackWhole()
    {
        WithMeshAndScript();
        var plain = Pack(Ba2, "Meshes/Actors/A.nif");

        var archive = Pack(Ba2 with { Compressed = true }, "Meshes/Actors/A.nif");

        Assert.True(archive.Length < plain.Length);
        Assert.Equal(Mesh, ContentsOf(Reader(GameRelease.Fallout4, archive)).Values.Single());
    }

    [Fact]
    public void AGeneralBa2_HeaderNamesTheVersionAndCountAndEachFileHashesItsStemAndFolder()
    {
        _folders.WithBytes(Mod, "meshes/actors/character/facegendata/facegeom/ordinator - perks of skyrim.esp/0006c67c.nif", Mesh);

        var archive = Pack(new Ba2Variant(1, Ba2Contents.General, Compressed: false),
            "meshes/actors/character/facegendata/facegeom/ordinator - perks of skyrim.esp/0006c67c.nif");

        Assert.Equal("BTDX", Encoding.ASCII.GetString(archive, 0, 4));
        Assert.Equal((1u, 1u), (U32(archive, 4), U32(archive, 12)));
        Assert.Equal("GNRL", Encoding.ASCII.GetString(archive, 8, 4));
        Assert.Equal((0x4A7CEDBDu, "nif\0", 0x241FD466u), (U32(archive, 24), Encoding.ASCII.GetString(archive, 28, 4), U32(archive, 32)));
    }

    [Fact]
    public void ATexturesBa2_HoldsEachDdsAsItsPixelDataUnderOneChunk()
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 2);
        _folders.WithBytes(Mod, "textures/a_d.dds", dds.File);

        var archive = Pack(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/a_d.dds");

        var extracted = ContentsOf(Reader(GameRelease.Fallout4, archive)).Single();
        Assert.Equal("textures\\a_d.dds", extracted.Key);
        Assert.Equal(dds.Pixels, extracted.Value[^dds.Pixels.Length..]);
        Assert.Equal("DXT1", Encoding.ASCII.GetString(extracted.Value, 84, 4));
    }

    [Fact]
    public void ACompressedTexturesBa2_ReadsBackTheSamePixelData()
    {
        var dds = Dds.Dxt1(width: 64, height: 64, mips: 1);
        _folders.WithBytes(Mod, "textures/a_d.dds", dds.File);

        var archive = Pack(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds");

        var extracted = ContentsOf(Reader(GameRelease.Fallout4, archive)).Single().Value;
        Assert.Equal(dds.Pixels, extracted[^dds.Pixels.Length..]);
    }

    [Fact]
    public void ADdsWithAnExtendedHeader_KeepsItsDxgiFormat()
    {
        var dds = Dds.Bc7(width: 8, height: 8);
        _folders.WithBytes(Mod, "textures/a_n.dds", dds.File);

        var archive = Pack(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/a_n.dds");

        var extracted = ContentsOf(Reader(GameRelease.Fallout4, archive)).Single().Value;
        Assert.Equal(dds.Pixels, extracted[^dds.Pixels.Length..]);
        Assert.Equal(98u, U32(extracted, 128));
    }

    [Fact]
    public void ATexturesBa2_RefusesAFileThatIsNotADds()
    {
        _folders.WithBytes(Mod, "textures/a.txt", Script);

        var refusal = Assert.Throws<InvalidDataException>(() =>
            Pack(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/a.txt"));

        Assert.Contains("textures/a.txt", refusal.Message);
    }

    [Fact]
    public void ADdsInAFormatTheArchiveCannotNameIsRefused()
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 1);
        BinaryPrimitives.WriteUInt32LittleEndian(dds.File.AsSpan(84), 0x31545845);
        _folders.WithBytes(Mod, "textures/a_d.dds", dds.File);

        Assert.Throws<InvalidDataException>(() =>
            Pack(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/a_d.dds"));
    }

    [Theory]
    [InlineData(GameRelease.Oblivion, 103u, 0x3u)]
    [InlineData(GameRelease.SkyrimLE, 104u, 0x3u)]
    [InlineData(GameRelease.SkyrimSE, 105u, 0x3u)]
    [InlineData(GameRelease.SkyrimSE, 105u, 0x7u)]
    public void ABsa_HoldsEachFileUnderItsLowercasedFolderAndName(GameRelease release, uint version, uint archiveFlags)
    {
        WithMeshAndScript();

        var archive = Pack(new BsaVariant(version, archiveFlags, FileFlags: 0x3), "Meshes/Actors/A.nif", "scripts/a.pex");

        var contents = ContentsOf(Reader(release, archive));
        Assert.Equal(["meshes\\actors\\a.nif", "scripts\\a.pex"], contents.Keys.Order());
        Assert.Equal(Mesh, contents["meshes\\actors\\a.nif"]);
        Assert.Equal(Script, contents["scripts\\a.pex"]);
    }

    [Fact]
    public void ACompressedBsa104_HoldsTheFileZlibCompressedBehindItsLength()
    {
        WithMeshAndScript();

        var archive = Pack(Bsa104 with { ArchiveFlags = 0x7 }, "Meshes/Actors/A.nif");

        var fileRecord = 36 + 16 + 1 + "meshes\\actors".Length + 1;
        var (size, offset) = (U32(archive, fileRecord + 8), (int)U32(archive, fileRecord + 12));
        Assert.Equal((uint)Mesh.Length, U32(archive, offset));
        using var inflated = new System.IO.Compression.ZLibStream(new MemoryStream(archive, offset + 4, (int)size - 4), System.IO.Compression.CompressionMode.Decompress);
        using var whole = new MemoryStream();
        inflated.CopyTo(whole);
        Assert.Equal(Mesh, whole.ToArray());
    }

    [Fact]
    public void ABsa_HashesFoldersAndFilesTheWayTheGameDoes()
    {
        _folders.WithBytes(Mod, "textures/excellent/ninelives.dds", Script);

        var archive = Pack(Bsa104, "textures/excellent/ninelives.dds");

        const int folderRecord = 36;
        Assert.Equal((0x0542982074126E74UL, 1u), (U64(archive, folderRecord), U32(archive, folderRecord + 8)));
        Assert.Equal(folderRecord + 16 + "ninelives.dds".Length + 1u, U32(archive, folderRecord + 12));
        var fileRecord = folderRecord + 16 + 1 + "textures\\excellent".Length + 1;
        Assert.Equal(0x66685F1E6E09E5F3UL, U64(archive, fileRecord));
    }

    [Fact]
    public void ABsa_ListsItsFilesInTheOrderTheGameSearchesThem()
    {
        _folders.WithBytes(Mod, "b/z.txt", Script).WithBytes(Mod, "a/y.txt", Script).WithBytes(Mod, "a/x.txt", Script);

        var archive = Pack(Bsa104, "b/z.txt", "a/y.txt", "a/x.txt");

        var hashes = Enumerable.Range(0, 2).Select(i => U64(archive, 36 + 16 * i)).ToList();
        Assert.Equal(hashes.Order(), hashes);
    }

    [Fact]
    public void ABsa_ListsTheFilesOfAFolderInTheOrderOfTheirHashes()
    {
        _folders.WithBytes(Mod, "a/zz.txt", Script).WithBytes(Mod, "a/ab.txt", Script).WithBytes(Mod, "a/m.txt", Script);

        var archive = Pack(Bsa104, "a/zz.txt", "a/ab.txt", "a/m.txt");

        var firstFileRecord = 36 + 16 + 1 + "a".Length + 1;
        var hashes = Enumerable.Range(0, 3).Select(i => U64(archive, firstFileRecord + 16 * i)).ToList();
        Assert.Equal(hashes.Order(), hashes);
    }

    [Fact]
    public void TwoFilesWhosePathsDifferOnlyInCase_AreRefused()
    {
        _folders.WithBytes(Mod, "Scripts/a.pex", Script).WithBytes(Mod, "scripts/A.pex", Script);

        Assert.Throws<InvalidDataException>(() => Pack(Ba2, "Scripts/a.pex", "scripts/A.pex"));
    }

    [Fact]
    public void ANameTheBsaCannotSpell_IsRefusedRatherThanWrittenWrong()
    {
        _folders.WithBytes(Mod, "scripts/日本.pex", Script);

        Assert.Throws<InvalidDataException>(() => Pack(Bsa104, "scripts/日本.pex"));
    }

    [Fact]
    public void AnArchiveVersionNoWriterHere_IsRefused()
    {
        WithMeshAndScript();

        Assert.Throws<NotSupportedException>(() => Pack(new Ba2Variant(3, Ba2Contents.General, Compressed: false), "scripts/a.pex"));
        Assert.Throws<NotSupportedException>(() => Pack(new BsaVariant(36, 3, 3), "scripts/a.pex"));
    }

    [Fact]
    public void AFileThatCannotBeRead_WritesNoArchive()
    {
        WithMeshAndScript();
        _folders.Unreadable.Add((Mod, "scripts/a.pex"));

        Assert.Throws<IOException>(() => Pack(Ba2, "Meshes/Actors/A.nif", "scripts/a.pex"));
        Assert.Empty(_folders.Written);
    }

    private static uint U32(byte[] bytes, int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at));

    private static ulong U64(byte[] bytes, int at) => BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(at));
}
