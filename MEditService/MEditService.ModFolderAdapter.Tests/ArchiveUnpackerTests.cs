using System.Buffers.Binary;
using System.Text;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ArchiveUnpackerTests : IDisposable
{
    private const string Meshes = "Meshes/Actors/A.nif";
    private const string Scripts = "scripts/a.pex";

    private static readonly byte[] Mesh = Encoding.ASCII.GetBytes(new string('n', 4000));
    private static readonly byte[] Script = Encoding.ASCII.GetBytes("Scriptname A");

    private readonly ScratchDirectory _scratch = new("archive-unpacker-");
    private readonly Dictionary<string, Func<Stream>> _assets = [];

    public void Dispose() => _scratch.Dispose();

    private string Packed(IArchiveVariant variant, params string[] files)
    {
        var archive = Path.Combine(_scratch, "Mod - Main.archive");
        var refusal = new ArchivePacker(new ModFolderRepository())
            .Pack(_scratch, "Mod - Main.archive", [.. files.Select(file => new ArchiveFile(file, _assets[file]))], variant);
        Assert.Null(refusal);
        return archive;
    }

    private ArchiveUnpackerTests With(string path, byte[] bytes)
    {
        _assets[path] = () => new MemoryStream(bytes);
        return this;
    }

    private static byte[] Read(ArchiveFile file)
    {
        using var content = file.Open();
        using var whole = new MemoryStream();
        content.CopyTo(whole);
        return whole.ToArray();
    }

    private static IReadOnlyList<ArchiveFile> Unpacked(GameRelease release, string archive, params string[] files)
    {
        Assert.Null(ArchiveUnpacker.Unpack(release, archive, files, out var unpacked));
        return unpacked;
    }

    private static ArchiveStepRefusal Refused(GameRelease release, string archive, params string[] files)
    {
        var refusal = ArchiveUnpacker.Unpack(release, archive, files, out var unpacked);
        Assert.Empty(unpacked);
        return Assert.IsType<ArchiveStepRefusal>(refusal);
    }

    [Fact]
    public void AGeneralBa2_UnpacksTheFilesItIsAskedForUnderThePathsAskedFor()
    {
        With(Meshes, Mesh).With(Scripts, Script);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: true), Meshes, Scripts);

        var files = Unpacked(GameRelease.Fallout4, archive, "scripts/a.pex");

        var unpacked = Assert.Single(files);
        Assert.Equal("scripts/a.pex", unpacked.Path);
        Assert.Equal(Script, Read(unpacked));
    }

    [Fact]
    public void ABsa_UnpacksAFileWhoseEntryIsSpelledInAnotherCase()
    {
        With(Meshes, Mesh);
        var archive = Packed(new BsaVariant(104, ArchiveFlags: 0x3, FileFlags: 0x3), Meshes);

        var files = Unpacked(GameRelease.SkyrimLE, archive, "MESHES/actors/A.NIF");

        Assert.Equal(Mesh, Read(Assert.Single(files)));
    }

    [Fact]
    public void ATexturesBa2_UnpacksADdsWhoseHeaderIsRebuiltAroundItsPixels()
    {
        var dds = Dds.Dxt1(width: 8, height: 8, mips: 2);
        With("textures/a_d.dds", dds.File);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), "textures/a_d.dds");

        var files = Unpacked(GameRelease.Fallout4, archive, "textures/a_d.dds");

        Assert.Equal(dds.Pixels, Read(Assert.Single(files))[^dds.Pixels.Length..]);
    }

    [Fact]
    public void AFileTheArchiveLacks_RefusesTheArchiveNamingIt()
    {
        With(Meshes, Mesh);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: false), Meshes);

        var refusal = Refused(GameRelease.Fallout4, archive, Meshes, "scripts/none.pex");

        Assert.Equal(ArchiveRefusal.FileNotInArchive, refusal.Reason);
        Assert.Contains("scripts/none.pex", refusal.Message);
    }

    [Fact]
    public void TwoEntriesThatNameOneFileWithoutRegardToCase_RefuseTheArchiveNamingBoth()
    {
        With("Meshes/A.nif", Mesh).With("meshes/a.nif", Script);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: false), "Meshes/A.nif", "meshes/a.nif");

        var refusal = Refused(GameRelease.Fallout4, archive, "meshes/a.nif");

        Assert.Equal(ArchiveRefusal.EntriesAmbiguous, refusal.Reason);
    }

    [Fact]
    public void ATextureMutagenCannotRebuildTheHeaderOf_RefusesTheArchiveInsteadOfThrowingAtTheWrite()
    {
        var unsupported = Dds.Bc7(8, 8).File;
        BinaryPrimitives.WriteUInt32LittleEndian(unsupported.AsSpan(128), 10);
        With("textures/odd.dds", unsupported);
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: false), "textures/odd.dds");

        var refusal = Refused(GameRelease.Fallout4, archive, "textures/odd.dds");

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
    }

    [Fact]
    public void AFileThatIsNoArchive_RefusesItAsUnreadable()
    {
        var notAnArchive = Path.Combine(_scratch, "Mod - Main.ba2");
        File.WriteAllText(notAnArchive, "this is not a BA2");

        var refusal = Refused(GameRelease.Fallout4, notAnArchive, Meshes);

        Assert.Equal(ArchiveRefusal.ArchiveUnreadable, refusal.Reason);
    }
}
