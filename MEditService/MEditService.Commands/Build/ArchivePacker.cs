using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

public sealed class ArchivePacker(IModFolderRepository repository)
{
    public PackRefusal? Pack(string modFolder, IReadOnlyList<string> files, string archivePath, IArchiveVariant variant)
    {
        try
        {
            var packed = Named(modFolder, files);
            repository.WriteFile(modFolder, archivePath, output =>
            {
                switch (variant)
                {
                    case Ba2Variant ba2:
                        Ba2Writer.Write(output, ba2, packed);
                        break;
                    case BsaVariant bsa:
                        BsaWriter.Write(output, bsa, packed);
                        break;
                    default:
                        throw new NotSupportedException($"{variant.GetType().Name} is not an archive variant.");
                }
            });
            return null;
        }
        catch (NotSupportedException e)
        {
            return new PackRefusal(ArchiveRefusal.VariantNotWritten, e.Message);
        }
        catch (InvalidDataException e)
        {
            return new PackRefusal(ArchiveRefusal.FileNotPackable, e.Message);
        }
        catch (OverflowException)
        {
            return new PackRefusal(ArchiveRefusal.FileNotPackable, "A size or offset in the archive would exceed 4 GiB.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new PackRefusal(ArchiveRefusal.NotWritten, $"The archive was not written: {e.Message}");
        }
    }

    private List<PackedFile> Named(string modFolder, IReadOnlyList<string> files)
    {
        var packed = files
            .Select(file => new PackedFile(file, file.ToLowerInvariant().Replace('/', '\\'), () => repository.OpenFile(modFolder, file)))
            .ToList();
        var clashes = packed.GroupBy(file => file.Name).Where(group => group.Count() > 1).ToList();
        if (clashes.Count > 0)
        {
            throw new InvalidDataException(
                $"An archive names a file once: {string.Join("; ", clashes.Select(c => string.Join(" and ", c.Select(f => $"'{f.Source}'"))))}.");
        }

        return packed;
    }
}
