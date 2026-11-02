namespace MEditService.ModFolderAdapter;

public sealed class ArchivePacker(IModFolderRepository repository)
{
    /// <summary>Writes the archive at <paramref name="archivePath"/> under <paramref name="folder"/> from
    /// <paramref name="files"/>; the refusal when it was not written.</summary>
    public ArchiveStepRefusal? Pack(string folder, string archivePath, IReadOnlyList<ArchiveFile> files, IArchiveVariant variant)
    {
        try
        {
            if (!(variant switch { Ba2Variant ba2 => Ba2Writer.Writes(ba2), BsaVariant bsa => BsaWriter.Writes(bsa), _ => false }))
                return new ArchiveStepRefusal(ArchiveRefusal.VariantNotWritten, $"{variant} is not written.");

            List<PackedFile> packed = [.. files.Select(file => new PackedFile(file.Path, file.Path.ToLowerInvariant().Replace('/', '\\'), file.Open))];
            repository.WriteFile(folder, archivePath, output =>
            {
                if (variant is Ba2Variant ba2) Ba2Writer.Write(output, ba2, packed);
                else BsaWriter.Write(output, (BsaVariant)variant, packed);
            });
            return null;
        }
        catch (InvalidDataException e)
        {
            return new ArchiveStepRefusal(ArchiveRefusal.FileNotPackable, e.Message);
        }
        catch (OverflowException)
        {
            return new ArchiveStepRefusal(ArchiveRefusal.FileNotPackable, "A size or offset in the archive would exceed 4 GiB.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return new ArchiveStepRefusal(ArchiveRefusal.NotWritten, $"The archive was not written: {e.Message}");
        }
    }
}
