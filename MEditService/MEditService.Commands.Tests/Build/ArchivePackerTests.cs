using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.Commands.Tests.Build;

public sealed class ArchivePackerTests : IDisposable
{
    private const string Mod = "mods/Mod";
    private const string SourceFolder = "source/Mod";
    private const string Assets = "source/Mod/assets";
    private const string Archive = "Mod - Main.archive";
    private const string Meshes = "Meshes/Actors/A.nif";
    private const string Scripts = "scripts/a.pex";

    private static readonly byte[] Mesh = Encoding.ASCII.GetBytes(new string('n', 4000));
    private static readonly byte[] Script = Encoding.ASCII.GetBytes("Scriptname A");

    private static readonly Ba2Variant Ba2 = new(1, Ba2Contents.General, Compressed: false);
    private static readonly BsaVariant Bsa104 = new(104, ArchiveFlags: 0x3, FileFlags: 0x3);

    private readonly FakeModFolders _folders = new();
    private readonly ScratchDirectory _scratch = new("archive-packer-");

    public static TheoryData<uint, bool> GeneralBa2s => new()
    {
        { 1, false }, { 1, true }, { 2, false }, { 2, true },
    };

    public static TheoryData<uint, bool> TextureBa2s => new() { { 1, false }, { 1, true }, { 2, false }, { 2, true }, { 3, true } };

    public static TheoryData<uint, Ba2Contents, bool> Ba2sNotWritten => new()
    {
        { 0, Ba2Contents.General, false },
        { 4, Ba2Contents.General, false },
        { 3, Ba2Contents.General, true },
        { 3, Ba2Contents.General, false },
        { 3, Ba2Contents.Textures, false },
        { 7, Ba2Contents.General, false },
        { 8, Ba2Contents.General, true },
    };

    public static TheoryData<uint, uint> BsasNotWritten => new()
    {
        { 36, 0x3 }, { 102, 0x3 }, { 106, 0x3 }, { 104, 0x0 }, { 104, 0x1 }, { 104, 0x103 }, { 104, 0x43 },
    };

    public void Dispose() => _scratch.Dispose();

    private async Task<(byte[]? Archive, ArchiveRefused? Refusal)> PackAsync(IArchiveVariant variant, params string[] files)
    {
        var source = new FakeSourceAdapter().Building(SourceFolder, new SourceToBuild(
            "Mod", [], [new ArchiveToPack(Archive, files)], [], [.. files.Select(file => new Asset(file, () => _folders.OpenFile(Assets, file)))]));
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(_scratch, null, GameRelease.Fallout4, []));

        var built = (await TestEditService.BuildModHandler(holder, source: source, modFolders: _folders)
            .BuildAsync([new ModToBuild("Mod", SourceFolder, Mod, [], null, IsSubmodule: false)], new InstanceToBuild(".mohidden", new ArchiveVariants(variant, variant), "stat-cache"))).Value();

        return (_folders.Written.GetValueOrDefault((Mod, Archive)), Assert.Single(built.Applied).ArchivesRefused.SingleOrDefault());
    }

    private async Task<byte[]> PackedAsync(IArchiveVariant variant, params string[] files)
    {
        var (archive, refusal) = await PackAsync(variant, files);
        Assert.Null(refusal);
        return Assert.IsType<byte[]>(archive);
    }

    private async Task<ArchiveRefused> RefusedAsync(IArchiveVariant variant, params string[] files)
    {
        var (archive, refusal) = await PackAsync(variant, files);
        Assert.Null(archive);
        return Assert.IsType<ArchiveRefused>(refusal);
    }

    private IArchiveReader Reader(GameRelease release, byte[] archive)
    {
        var path = System.IO.Path.Combine(_scratch, "read" + System.IO.Path.GetRandomFileName());
        File.WriteAllBytes(path, archive);
        return Mutagen.Bethesda.Archives.Archive.CreateReader(release, path);
    }

    private static Dictionary<string, byte[]> ContentsOf(IArchiveReader reader) =>
        reader.Files.ToDictionary(f => f.Path.Replace('/', '\\'), f => f.GetBytes());

    private FakeModFolders WithMeshAndScript() => _folders.WithBytes(Assets, Meshes, Mesh).WithBytes(Assets, Scripts, Script);

    private static void AssertEveryReferenceReaderSees(byte[] archive, Dictionary<string, byte[]> expected)
    {
        Assert.Equal(expected, Ba2Oracle.Read(archive, Ba2Oracle.WabbajackHeaderLength));
        Assert.Equal(expected, Ba2Oracle.Read(archive, Ba2Oracle.CreationsForgeHeaderLength));
    }

    [Fact]
    public async Task AGeneralBa2_ReadsBackThroughMutagenUnderLowercasedBackslashPaths()
    {
        WithMeshAndScript();

        var contents = ContentsOf(Reader(GameRelease.Fallout4, await PackedAsync(Ba2, Meshes, Scripts)));

        Assert.Equal(["meshes\\actors\\a.nif", "scripts\\a.pex"], contents.Keys.Order());
        Assert.Equal(Mesh, contents["meshes\\actors\\a.nif"]);
        Assert.Equal(Script, contents["scripts\\a.pex"]);
    }

    [Fact]
    public async Task ACompressedGeneralBa2_ReadsBackThroughMutagen()
    {
        WithMeshAndScript();

        var archive = await PackedAsync(Ba2 with { Compressed = true }, Meshes);

        Assert.True(archive.Length < (await PackedAsync(Ba2, Meshes)).Length);
        Assert.Equal(Mesh, ContentsOf(Reader(GameRelease.Fallout4, archive)).Values.Single());
    }

    [Theory]
    [MemberData(nameof(GeneralBa2s))]
    public async Task AGeneralBa2_ReadsBackThroughBothReferenceReaders(uint version, bool compressed)
    {
        WithMeshAndScript();

        var archive = await PackedAsync(new Ba2Variant(version, Ba2Contents.General, compressed), Meshes, Scripts);

        AssertEveryReferenceReaderSees(archive, new() { ["meshes\\actors\\a.nif"] = Mesh, ["scripts\\a.pex"] = Script });
    }

    [Theory]
    [MemberData(nameof(TextureBa2s))]
    public async Task ATexturesBa2_ReadsBackItsPixelDataThroughBothReferenceReaders(uint version, bool compressed)
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 2);
        _folders.WithBytes(Assets, "textures/a_d.dds", dds.File);

        var archive = await PackedAsync(new Ba2Variant(version, Ba2Contents.Textures, compressed), "textures/a_d.dds");

        AssertEveryReferenceReaderSees(archive, new() { ["textures\\a_d.dds"] = dds.Pixels });
    }

    [Fact]
    public async Task AVersion3TexturesBa2_HeaderNamesLz4ItsCompression()
    {
        _folders.WithBytes(Assets, "textures/a_d.dds", Dds.Dxt1(8, 8, 1).File);

        var archive = await PackedAsync(new Ba2Variant(3, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds");

        Assert.Equal((1ul, 3u), (U64(archive, 24), U32(archive, 32)));
    }

    [Fact]
    public async Task ATexturesBa2_ReadsBackThroughMutagenWithItsFormat()
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 2);
        _folders.WithBytes(Assets, "textures/a_d.dds", dds.File);

        var extracted = ContentsOf(Reader(GameRelease.Fallout4, await PackedAsync(new Ba2Variant(1, Ba2Contents.Textures, false), "textures/a_d.dds"))).Single();

        Assert.Equal("textures\\a_d.dds", extracted.Key);
        Assert.Equal(dds.Pixels, extracted.Value[^dds.Pixels.Length..]);
        Assert.Equal("DXT1", Encoding.ASCII.GetString(extracted.Value, 84, 4));
    }

    [Fact]
    public async Task ADdsWithAnExtendedHeader_KeepsItsDxgiFormat()
    {
        var dds = Dds.Bc7(width: 8, height: 8);
        _folders.WithBytes(Assets, "textures/a_n.dds", dds.File);

        var extracted = ContentsOf(Reader(GameRelease.Fallout4, await PackedAsync(new Ba2Variant(1, Ba2Contents.Textures, false), "textures/a_n.dds"))).Single().Value;

        Assert.Equal(dds.Pixels, extracted[^dds.Pixels.Length..]);
        Assert.Equal(98u, U32(extracted, 128));
    }

    [Fact]
    public async Task AGeneralBa2_HeaderNamesTheVersionAndCountAndEachFileHashesItsStemAndFolder()
    {
        const string path = "meshes/actors/character/facegendata/facegeom/ordinator - perks of skyrim.esp/0006c67c.nif";
        _folders.WithBytes(Assets, path, Mesh);

        var archive = await PackedAsync(Ba2, path);

        Assert.Equal("BTDX", Encoding.ASCII.GetString(archive, 0, 4));
        Assert.Equal((1u, 1u), (U32(archive, 4), U32(archive, 12)));
        Assert.Equal("GNRL", Encoding.ASCII.GetString(archive, 8, 4));
        Assert.Equal((0x4A7CEDBDu, "nif\0", 0x241FD466u), (U32(archive, 24), Encoding.ASCII.GetString(archive, 28, 4), U32(archive, 32)));
    }

    [Theory]
    [MemberData(nameof(Ba2sNotWritten))]
    public async Task ABa2NoReaderAgreesOn_IsNotWritten(uint version, Ba2Contents contents, bool compressed)
    {
        WithMeshAndScript();

        var refusal = await RefusedAsync(new Ba2Variant(version, contents, compressed), Scripts);

        Assert.Equal(ArchiveRefusal.VariantNotWritten, refusal.Refusal);
    }

    [Theory]
    [MemberData(nameof(BsasNotWritten))]
    public async Task ABsaWithoutAWriter_IsNotWritten(uint version, uint archiveFlags)
    {
        WithMeshAndScript();

        var refusal = await RefusedAsync(new BsaVariant(version, archiveFlags, FileFlags: 3), Scripts);

        Assert.Equal(ArchiveRefusal.VariantNotWritten, refusal.Refusal);
    }

    [Theory]
    [InlineData(GameRelease.Oblivion, 103u, 0x3u)]
    [InlineData(GameRelease.SkyrimLE, 104u, 0x3u)]
    [InlineData(GameRelease.SkyrimSE, 105u, 0x3u)]
    [InlineData(GameRelease.SkyrimSE, 105u, 0x7u)]
    public async Task ABsa_ReadsBackThroughMutagenUnderLowercasedFolderAndName(GameRelease release, uint version, uint archiveFlags)
    {
        WithMeshAndScript();

        var contents = ContentsOf(Reader(release, await PackedAsync(new BsaVariant(version, archiveFlags, FileFlags: 0x3), Meshes, Scripts)));

        Assert.Equal(["meshes\\actors\\a.nif", "scripts\\a.pex"], contents.Keys.Order());
        Assert.Equal(Mesh, contents["meshes\\actors\\a.nif"]);
        Assert.Equal(Script, contents["scripts\\a.pex"]);
    }

    [Fact]
    public async Task ACompressedBsa104_HoldsTheFileZlibCompressedBehindItsLength()
    {
        WithMeshAndScript();

        var archive = await PackedAsync(Bsa104 with { ArchiveFlags = 0x7 }, Meshes);

        var fileRecord = 36 + 16 + 1 + "meshes\\actors".Length + 1 + 8;
        var (size, offset) = (U32(archive, fileRecord), (int)U32(archive, fileRecord + 4));
        Assert.Equal((uint)Mesh.Length, U32(archive, offset));
        using var inflated = new ZLibStream(new MemoryStream(archive, offset + 4, (int)size - 4), CompressionMode.Decompress);
        using var whole = new MemoryStream();
        inflated.CopyTo(whole);
        Assert.Equal(Mesh, whole.ToArray());
    }

    [Fact]
    public async Task ABsa_HashesFoldersAndFilesTheWayTheGameDoes()
    {
        _folders.WithBytes(Assets, "textures/excellent/ninelives.dds", Script);

        var archive = await PackedAsync(Bsa104, "textures/excellent/ninelives.dds");

        const int folderRecord = 36;
        Assert.Equal((0x0542982074126E74UL, 1u), (U64(archive, folderRecord), U32(archive, folderRecord + 8)));
        Assert.Equal(folderRecord + 16 + "ninelives.dds".Length + 1u, U32(archive, folderRecord + 12));
        var fileRecord = folderRecord + 16 + 1 + "textures\\excellent".Length + 1;
        Assert.Equal(0x66685F1E6E09E5F3UL, U64(archive, fileRecord));
    }

    [Fact]
    public async Task ABsa_ListsItsFoldersInTheOrderOfTheirHashes()
    {
        _folders.WithBytes(Assets, "b/z.txt", Script).WithBytes(Assets, "a/y.txt", Script).WithBytes(Assets, "a/x.txt", Script);

        var archive = await PackedAsync(Bsa104, "b/z.txt", "a/y.txt", "a/x.txt");

        var hashes = Enumerable.Range(0, 2).Select(i => U64(archive, 36 + 16 * i)).ToList();
        Assert.Equal(hashes.Order(), hashes);
    }

    [Fact]
    public async Task ABsa_ListsTheFilesOfAFolderInTheOrderOfTheirHashes()
    {
        _folders.WithBytes(Assets, "a/zz.txt", Script).WithBytes(Assets, "a/ab.txt", Script).WithBytes(Assets, "a/m.txt", Script);

        var archive = await PackedAsync(Bsa104, "a/zz.txt", "a/ab.txt", "a/m.txt");

        var firstFileRecord = 36 + 16 + 1 + "a".Length + 1;
        var hashes = Enumerable.Range(0, 3).Select(i => U64(archive, firstFileRecord + 16 * i)).ToList();
        Assert.Equal(hashes.Order(), hashes);
    }

    [Fact]
    public async Task ABsa_SpellsANameInWindows1252()
    {
        _folders.WithBytes(Assets, "scripts/it’s.pex", Script);

        var archive = await PackedAsync(Bsa104, "scripts/it’s.pex");

        Assert.Contains((byte)0x92, archive);
    }

    [Fact]
    public async Task ABsa_RefusesANameWindows1252CannotSpell()
    {
        _folders.WithBytes(Assets, "scripts/日本.pex", Script);

        var refusal = await RefusedAsync(Bsa104, "scripts/日本.pex");

        Assert.Equal(ArchiveRefusal.FileNotPackable, refusal.Refusal);
    }

    [Fact]
    public async Task ABsa_RefusesAFileWhoseSizeSetsTheCompressionBit()
    {
        _folders.WithStream(Assets, "scripts/big.pex", () => new LengthOnlyStream(1L << 30));

        var refusal = await RefusedAsync(Bsa104, "scripts/big.pex");

        Assert.Equal(ArchiveRefusal.FileNotPackable, refusal.Refusal);
        Assert.Contains("scripts/big.pex", refusal.Message);
    }

    [Fact]
    public async Task AFileThatCannotBeRead_WritesNoArchive()
    {
        WithMeshAndScript();
        _folders.Unreadable.Add((Assets, Scripts));

        var refusal = await RefusedAsync(Ba2, Meshes, Scripts);

        Assert.Equal(ArchiveRefusal.NotWritten, refusal.Refusal);
    }

    [Fact]
    public async Task AStreamThatCannotBeRead_IsNotAVariantRefusal()
    {
        _folders.WithStream(Assets, Scripts, () => throw new NotSupportedException("no reads"));

        var refusal = await RefusedAsync(Ba2, Scripts);

        Assert.Equal(ArchiveRefusal.NotWritten, refusal.Refusal);
    }

    [Theory]
    [InlineData("textures/a.txt")]
    [InlineData("textures/unknown_format.dds")]
    [InlineData("textures/array.dds")]
    [InlineData("textures/volume.dds")]
    [InlineData("textures/empty.dds")]
    public async Task ATexturesBa2_RefusesAFileThatIsNoSingle2DTextureOfAKnownFormat(string path)
    {
        var unknownFormat = Dds.Dxt1(8, 8, 1).File;
        BinaryPrimitives.WriteUInt32LittleEndian(unknownFormat.AsSpan(84), 0x31545845);
        var array = Dds.Bc7(8, 8).File;
        BinaryPrimitives.WriteUInt32LittleEndian(array.AsSpan(128 + 12), 2);
        var volume = Dds.Dxt1(8, 8, 1).File;
        BinaryPrimitives.WriteUInt32LittleEndian(volume.AsSpan(112), 0x200000);
        _folders.WithBytes(Assets, "textures/a.txt", Script)
            .WithBytes(Assets, "textures/unknown_format.dds", unknownFormat)
            .WithBytes(Assets, "textures/array.dds", array)
            .WithBytes(Assets, "textures/volume.dds", volume)
            .WithBytes(Assets, "textures/empty.dds", Dds.Dxt1(8, 8, 1).File[..128]);

        var refusal = await RefusedAsync(new Ba2Variant(1, Ba2Contents.Textures, false), path);

        Assert.Equal(ArchiveRefusal.FileNotPackable, refusal.Refusal);
        Assert.Contains(path, refusal.Message);
    }

    private static uint U32(byte[] bytes, int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at));

    private static ulong U64(byte[] bytes, int at) => BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(at));

    private sealed class LengthOnlyStream(long length) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => true;

        public override bool CanWrite => false;

        public override long Length => length;

        public override long Position { get; set; }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => 0;

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
