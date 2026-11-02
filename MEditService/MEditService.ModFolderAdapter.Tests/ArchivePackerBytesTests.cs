using System.Text;
using MEditService.TestSupport;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ArchivePackerBytesTests : IDisposable
{
    private readonly ScratchDirectory _scratch = new("archive-packer-bytes-");

    public void Dispose() => _scratch.Dispose();

    private byte[] Packed(IArchiveVariant variant, params (string Path, byte[] Bytes)[] files)
    {
        var refusal = new ArchivePacker(new ModFolderRepository())
            .Pack(_scratch, "out.archive", [.. files.Select(file => new ArchiveFile(file.Path, () => new MemoryStream(file.Bytes)))], variant);
        Assert.Null(refusal);
        return File.ReadAllBytes(Path.Combine(_scratch, "out.archive"));
    }

    [Fact]
    public void AGeneralBa2_IsTheSameBytesOnEveryMachine()
    {
        var archive = Packed(new Ba2Variant(1, Ba2Contents.General, Compressed: true),
            ("Meshes/Actors/A.nif", Encoding.ASCII.GetBytes(string.Concat(Enumerable.Repeat("nif data ", 500)))),
            ("scripts/a.pex", Encoding.ASCII.GetBytes("Scriptname A")));

        Golden.VerifyBytes("pack-general.ba2", archive);
    }

    [Fact]
    public void ATexturesBa2_IsTheSameBytesOnEveryMachine()
    {
        var archive = Packed(new Ba2Variant(1, Ba2Contents.Textures, Compressed: true), ("textures/a_d.dds", Dds.Dxt1(width: 64, height: 64, mips: 4).File));

        Golden.VerifyBytes("pack-textures.ba2", archive);
    }
}
