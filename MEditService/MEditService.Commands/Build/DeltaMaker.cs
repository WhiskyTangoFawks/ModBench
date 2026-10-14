using MEditService.ModFolderAdapter;
using SharpCompress.Common;

namespace MEditService.Commands.Build;

/// <summary>Keeps each delta a mod's files are proposed to come from, from the build folder or made from its base.
/// A file whose delta is larger than its share of the file has no provider.</summary>
internal sealed class DeltaMaker(
    IModFolderRepository repository, InstanceToUpdate instance, string modFolder, IReadOnlyList<(string Name, InstallationFile File)> installationFiles)
{
    /// <summary>True once the build folder refused a delta, whose exception then ends Keep.</summary>
    public bool NotWritten { get; private set; }

    public FileProvider[] Keep(IReadOnlyList<(HashedFile File, FileProvider Provider)> proposed)
    {
        var providers = proposed.Select(p => BaseHashOf(p.Provider) is null ? p.Provider : new FileProvider.NoProvider()).ToArray();
        List<(int At, HashedFile File, FileProvider Provider, string BaseHash)> toMake = [];
        foreach (var (at, (file, provider)) in proposed.Index())
        {
            if (BaseHashOf(provider) is not { } baseHash) continue;
            if (repository.DeltaSize(instance.BuildFolder, file.Path, baseHash, file.Hash) is not { } size) toMake.Add((at, file, provider, baseHash));
            else if (WithinShare(size, file)) providers[at] = provider;
        }

        foreach (var fromOne in toMake.Where(d => d.Provider is FileProvider.InstallationFileDelta)
            .GroupBy(d => ((FileProvider.InstallationFileDelta)d.Provider).InstallationFile))
        {
            var wanted = fromOne.ToLookup(d => ((FileProvider.InstallationFileDelta)d.Provider).Path, StringComparer.Ordinal);
            using var archive = repository.OpenInstallationFile(installationFiles.First(file => file.Name == fromOne.Key).File.Path);
            try
            {
                ArchiveExtractor.Extract(archive, (path, content) =>
                {
                    if (!wanted.Contains(path)) return;
                    using var basis = Written(() => repository.CreateScratchFile(instance.BuildFolder));
                    content.CopyTo(basis);
                    foreach (var delta in wanted[path]) Make(delta, basis);
                });
            }
            catch (SharpCompressException e)
            {
                throw new IOException($"'{fromOne.Key}' is not an archive update manifest can read: {e.Message}", e);
            }
        }

        foreach (var delta in toMake.Where(d => d.Provider is FileProvider.GameFileDelta))
        {
            using var basis = repository.OpenGameFile(instance.DataFolder, ((FileProvider.GameFileDelta)delta.Provider).Path);
            Make(delta, basis);
        }

        return providers;

        void Make((int At, HashedFile File, FileProvider Provider, string BaseHash) delta, Stream basis)
        {
            basis.Position = 0;
            using var target = repository.OpenFile(modFolder, delta.File.Path);
            var kept = Written(() => repository.WriteDelta(instance.BuildFolder, delta.File.Path, delta.BaseHash, delta.File.Hash, made =>
            {
                OctodiffDelta.Write(basis, target, made);
                return WithinShare(made.Length, delta.File);
            }));
            if (kept) providers[delta.At] = delta.Provider;
        }
    }

    private T Written<T>(Func<T> write)
    {
        try
        {
            return write();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            NotWritten = true;
            throw;
        }
    }

    private bool WithinShare(long deltaSize, HashedFile file) => deltaSize <= instance.DeltaShare * file.Size;

    private static string? BaseHashOf(FileProvider provider) => provider switch
    {
        FileProvider.InstallationFileDelta delta => delta.BaseHash,
        FileProvider.GameFileDelta delta => delta.BaseHash,
        _ => null,
    };
}
