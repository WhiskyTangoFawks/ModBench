using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Packs files of a mod folder into one archive in that folder, in the variant the game release calls
/// for. The archive lands whole or not at all.</summary>
public sealed class ArchivePacker(IModFolderRepository repository)
{
    public void Pack(string modFolder, IReadOnlyList<string> files, string archivePath, IArchiveVariant variant)
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
