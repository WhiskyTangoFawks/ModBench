using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

internal sealed class ArchivePacker(IModFolderRepository repository)
{
    /// <summary>Writes the archive at <paramref name="archivePath"/> under <paramref name="folder"/> from
    /// <paramref name="files"/>: true when it replaced an archive that held other bytes.</summary>
    public Answer<bool, PackRefusal> Pack(string folder, string archivePath, IReadOnlyList<Asset> files, IArchiveVariant variant)
    {
        try
        {
            if (!(variant switch { Ba2Variant ba2 => Ba2Writer.Writes(ba2), BsaVariant bsa => BsaWriter.Writes(bsa), _ => false }))
                return new PackRefusal(ArchiveRefusal.VariantNotWritten, $"{variant} is not written.");

            List<PackedFile> packed = [.. files.Select(file => new PackedFile(file.Path, file.Path.ToLowerInvariant().Replace('/', '\\'), file.Open))];
            return repository.WriteFile(folder, archivePath, output =>
            {
                if (variant is Ba2Variant ba2) Ba2Writer.Write(output, ba2, packed);
                else BsaWriter.Write(output, (BsaVariant)variant, packed);
            });
        }
        catch (InvalidDataException e)
        {
            return new PackRefusal(ArchiveRefusal.FileNotPackable, e.Message);
        }
        catch (OverflowException)
        {
            return new PackRefusal(ArchiveRefusal.FileNotPackable, "A size or offset in the archive would exceed 4 GiB.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return new PackRefusal(ArchiveRefusal.NotWritten, $"The archive was not written: {e.Message}");
        }
    }
}
